import * as vscode from 'vscode';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';
import * as jschardet from 'jschardet';
import * as fs from 'fs';
import * as path from 'path';

let idleTimer: NodeJS.Timeout | null = null;

interface ReadingState {
    url: string;
    position: number;
    bookshelf: Array<{
        bookname: string;
        chapterurl: string;
        position?: number; // 可选字段，表示书签位置
    }>;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Novel Reader extension is now active!');

    // 状态文件路径
    const stateFilePath = path.join(context.globalStorageUri.fsPath, 'readingState.json');
    
    // 确保目录存在
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    }
    
    let novelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    novelStatusBarItem.command = 'zouzhe-fish.nextContent';
    context.subscriptions.push(novelStatusBarItem);

    let nextChapterBtnBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    nextChapterBtnBarItem.command = 'zouzhe-fish.nextChapter';
    nextChapterBtnBarItem.text = '$(chevron-right)';
    nextChapterBtnBarItem.show();

    const wordsPerSegment = 30;
    // let currentUrl = 'https://www.wodeshucheng.net/book_94408250/432459891.html';
    // let currentUrl = 'https://www.xblqugex.cc/book_41834250/35270823.html';
    let currentUrl = 'http://www.2wxss.com/book/113462/44718744.html';
    let prevUrl = '';
    let nextUrl = '';
    let fullText = '';
    let bookname = '';
    let currentPosition = -wordsPerSegment;
    let chapterNumber = '';
  
    // 新增：计时器相关变量
    const idleTimeout = 5000; // 5秒
    let isShowingTest = false;
    idleTimer = setInterval(() => {
            isShowingTest = true;
            novelStatusBarItem.text = "running test";
            novelStatusBarItem.show();
        }, idleTimeout);
    
    // 保存阅读状态
    const saveReadingState = () => {
        const state = loadReadingState();
        let stateObject: ReadingState = {
            url: currentUrl,
            position: currentPosition,
            bookshelf: [{
                bookname: bookname,
                chapterurl: currentUrl,
                position: currentPosition // 保存当前章节位置
            }]
        };
        if (state) {
            stateObject = state;
            if (!stateObject.bookshelf) {
                stateObject.bookshelf = [];
            }
            // 检查是否已经存在相同的书籍
            const existingBookIndex = stateObject.bookshelf.findIndex(book => book.bookname === bookname);
            if (existingBookIndex !== -1) {
                // 如果存在，先删除
                stateObject.bookshelf.splice(existingBookIndex, 1);
            }
            stateObject.bookshelf.unshift({
                bookname: bookname,
                chapterurl: currentUrl,
                position: currentPosition // 保存当前章节位置
            });
        }
        fs.writeFileSync(stateFilePath, JSON.stringify(state));
    };

    // 加载阅读状态
    const loadReadingState = (): ReadingState | null => {
        try {
            if (fs.existsSync(stateFilePath)) {
                return JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
            }
        } catch (error) {
            console.error('加载阅读状态失败:', error);
        }
        return null;
    };


    // 获取章节内容并解析标题
    const fetchNovelContent = async (url: string) => {
        try {
            const response = await axios.get<ArrayBuffer>(url, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0'
                }
            });
            
            const responseData = Buffer.from(response.data);
            const detected = jschardet.detect(responseData);
            const encoding = detected.encoding || 'gbk';
            const html = iconv.decode(responseData, encoding);
            const $ = cheerio.load(html);
            
            const booktitledes = $('div.layout-tit.xs-hidden').find('a').last().attr('title');
            if (booktitledes){
                bookname = booktitledes;
            }
            //从#container > div > div > div.reader-main > h1标签提取章节标题
            let chapterTitle = $('body').find('h1').last().text() || '未知章节';
            //从text内容最长的div获取章节内容
            // 获取所有div，找到文本最长的div作为章节内容
            let maxLen = 0;
            let content = '';
            // 只查找没有子div的div（叶子div）,且div包含叶子p
            $('div').each((_, el) => {
                if ($(el).find('div').length === 0) {
                    if($(el).find('p').length > 0 || $(el).find('br').length > 0){
                        const text = $(el).text().trim();
                        if (text.length > maxLen) {
                            maxLen = text.length;
                            content = text;
                        }
                    }
                }
            });

            // 查找上一章、下一章、下一页链接
            prevUrl = '';
            nextUrl = '';
            // 查找所有a元素，匹配文本
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                if (!prevUrl && (text.includes('上一章') || text.includes('上一页'))) {
                    const href = $(el).attr('href');
                    if (href) {
                        prevUrl = new URL(href, url).href;
                    }
                }
                if (!nextUrl && (text.includes('下一章') || text.includes('下一页'))) {
                    const href = $(el).attr('href');
                    if (href) {
                        nextUrl = new URL(href, url).href;
                    }
                }
            });
            if (!prevUrl) {
                vscode.window.showInformationMessage('this is the first chapter');
            }
            if (!nextUrl) {
                vscode.window.showInformationMessage('this is the last chapter');
            }
            // 清理内容中的多余的换行
            content = content.replace(/\s+/g, ' ').trim();
            // 将标题插入正文开头和结尾
            return `【${chapterTitle}】${content}【${chapterTitle}】`;
            
        } catch (error) {
            vscode.window.showErrorMessage('get novel content fail: ' + (error as Error).message);
            return '';
        }
    };

    const updateStatusBar = (direct=1) => {
        // 如果当前正在显示test，则不更新内容
        if (isShowingTest){
            currentPosition = Math.max(currentPosition, 0);
        }else{
            currentPosition += direct*wordsPerSegment;
        }
        const segment = fullText.substring(Math.min(currentPosition, fullText.length-wordsPerSegment),
            currentPosition + wordsPerSegment);
        // 从章节标题中提取章节号
        chapterNumber = fullText.substring(0,50).match(/第(\d+)(章|节)/)?.[1] || '未知章节';
        //chapterNumber = fullText.substring(0,50).match(/\d{m,n}/)?.[1] || '未知章节';
        novelStatusBarItem.text = `[${chapterNumber}]${segment} [${Math.floor(currentPosition/wordsPerSegment)}/${Math.floor(fullText.length/wordsPerSegment)+1}]`;
        novelStatusBarItem.show();
        saveReadingState(); // 自动保存阅读位置
        isShowingTest=false;
    };

    // 加载上一章
    const loadPrevChapter = async () => {
        if (prevUrl) {
            currentUrl = prevUrl;
            fullText = await fetchNovelContent(currentUrl);
            currentPosition = -wordsPerSegment;
            updateStatusBar();
        } else {
            vscode.window.showInformationMessage('this is the first chapter');
        }
    };

    // 加载下一章
    const loadNextChapter = async () => {
        if (nextUrl) {
            currentUrl = nextUrl;
            fullText = await fetchNovelContent(currentUrl);
            currentPosition = -wordsPerSegment;
            updateStatusBar();
        } else {
            vscode.window.showInformationMessage('this is the last chapter');
        }
    };

    // 注册命令
    const openBookshelfCommand = vscode.commands.registerCommand('zouzhe-fish.openBookshelf', () => {
        const state = loadReadingState();
        if (state && state.bookshelf && state.bookshelf.length > 0) {
            const items = state.bookshelf.map(book => ({
                label: book.bookname,
                description: book.chapterurl,
                position: book.position || 0, // 使用可选位置字段
            }));
            vscode.window.showQuickPick(items, {
                placeHolder: '选择书籍',
                canPickMany: false,
            }).then(selected => {
                if (selected) {
                    currentUrl = selected.description;
                    fullText = '';
                    currentPosition = selected.position || 0; // 使用选中的位置
                    bookname = selected.label;
                    fetchNovelContent(currentUrl).then(content => {
                        fullText = content;
                        updateStatusBar();
                    }).catch(error => {
                        vscode.window.showErrorMessage('加载书籍内容失败: ' + (error as Error).message);
                    });
                }
            });
        } else {
            vscode.window.showInformationMessage('书架为空，请先阅读章节');
        }
    });
    const deleteBookCommand = vscode.commands.registerCommand('zouzhe-fish.deleteBook', () => {
        const state = loadReadingState();
        if (state && state.bookshelf && state.bookshelf.length > 0) {
            const items = state.bookshelf.map(book => ({
                label: book.bookname,
                description: book.chapterurl,
                position: book.position || 0 // 使用可选位置字段
            }));
            vscode.window.showQuickPick(items, {
                placeHolder: '选择要删除的书籍',
                canPickMany: false
            }).then(selected => {
                if (selected) {
                    // 从书架中删除选中的书籍
                    const index = state.bookshelf.findIndex(book => book.bookname === selected.label && book.chapterurl === selected.description);
                    if (index !== -1) {
                        state.bookshelf.splice(index, 1);
                        fs.writeFileSync(stateFilePath, JSON.stringify(state));
                        vscode.window.showInformationMessage(`已删除书籍: ${selected.label}`);
                        // 如果删除的是当前阅读的书籍，清除状态
                        if (currentUrl === selected.description) {
                            currentUrl = '';
                            fullText = '';  
                            currentPosition = -wordsPerSegment;
                            bookname = '';
                            novelStatusBarItem.hide();
                        }
                    } else {
                        vscode.window.showErrorMessage('未找到要删除的书籍');
                    }
                }
            });
        } else {
            vscode.window.showInformationMessage('书架为空，请先阅读章节');
        }
    });

    const nextContentCommand = vscode.commands.registerCommand('zouzhe-fish.nextContent', () => {
        currentPosition = Math.min(currentPosition, fullText.length);
        updateStatusBar();
    });
    const prevContentCommand = vscode.commands.registerCommand('zouzhe-fish.prevContent', () => {
        currentPosition = Math.max(currentPosition - wordsPerSegment, wordsPerSegment);
        updateStatusBar(-1);
    });

    const startReadingCommand = vscode.commands.registerCommand('zouzhe-fish.startReading', async () => {
        const url = await vscode.window.showInputBox({
            placeHolder: '输入章节URL',
            value: currentUrl
        });
        
        if (url) {
            currentUrl = url;
            fullText = await fetchNovelContent(currentUrl);
            currentPosition = -wordsPerSegment;
            updateStatusBar();
        }
    });

    // 停止阅读
    const stopReadingCommand = vscode.commands.registerCommand('zouzhe-fish.stopReading', () => {
        // 清除状态栏
        novelStatusBarItem.hide();
        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        nextChapterBtnBarItem.hide();
    });

    // 静默恢复阅读
    const restoreReading = async () => {
        const state = loadReadingState();
        if (state) {
            try {
                currentUrl = state.url;
                fullText = await fetchNovelContent(currentUrl);
                currentPosition = Math.min(state.position, fullText.length);
                updateStatusBar();
                return;
            } catch (error) {
                console.error('recovery reading status fail', error);
            }
        }
        // 恢复失败或没有保存的状态，正常开始
        vscode.commands.executeCommand('zouzhe-fish.startReading');
    };


    const nextChapterCommand = vscode.commands.registerCommand('zouzhe-fish.nextChapter', loadNextChapter);
    const prevChapterCommand = vscode.commands.registerCommand('zouzhe-fish.prevChapter', loadPrevChapter);

    context.subscriptions.push(
        nextContentCommand,
        prevContentCommand,
        startReadingCommand,
        nextChapterCommand,
        prevChapterCommand,
        stopReadingCommand,
        openBookshelfCommand,
        deleteBookCommand
    );
    // 自动尝试恢复阅读
    restoreReading();
}

export function deactivate() {
    // 清理计时器
    if (idleTimer) {
        clearTimeout(idleTimer);
    }
}