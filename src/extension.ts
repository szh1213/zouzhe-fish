import * as vscode from 'vscode';
import axios from 'axios';
import * as cheerio from 'cheerio';
import * as iconv from 'iconv-lite';
import * as jschardet from 'jschardet';
import * as fs from 'fs';
import * as path from 'path';


// 细腻的进度条字符集 (Unicode块字符)
const PROGRESS_CHARS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];
const PROGRESS_WIDTH = 24; // 进度条宽度

// 默认工作时间配置
interface WorkHoursConfig {
    workTimeProcessor: boolean; // 是否启用工作时间处理
    startHour: number;
    startMinute: number;
    endHour: number;
    endMinute: number;
    lunchStartHour: number;
    lunchStartMinute: number;
    lunchEndHour: number;
    lunchEndMinute: number;
}

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
    let currentUrl = 'https://www.xblqugex.cc/book_41834250/34070832.html';
    // let currentUrl = 'http://www.2wxss.com/book/113462/44718744.html';
    let prevUrl = '';
    let nextUrl = '';
    let bookUrl = '';
    let fullText = '';
    let bookname = '未知书籍';
    let currentPosition = -wordsPerSegment;
    let chapterNumber = '';
    let chapterTitle = '';
  
    // 新增：计时器相关变量
    const idleTimeout = 5000; // 5秒
    let isShowingTest = false;
    let idleTimer = setInterval(() => {
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
            stateObject.url = currentUrl;
            stateObject.position = currentPosition;
            // 如果书架不存在，则初始化
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
        fs.writeFileSync(stateFilePath, JSON.stringify(stateObject));
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
            
            chapterTitle = $('body').find('h1').last().text() || '未知章节';
            chapterNumber = chapterTitle.match(/第([零一二三四五六七八九十百千万亿\d]+)(?:章|节)/)?.[1] || '未知章节号';
            // 获取所有div，找到文本最长的div作为章节内容
            let maxLen = 0;
            let content = '';
            // 只查找没有子div的div（叶子div）,且div包含叶子p
            $('div').each((_, el) => {
                // 如果div的最后一个元素是a
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

            // 查找上一章、下一章、下一页链接、目录链接
            prevUrl = '';
            nextUrl = '';
            bookUrl = '';
            let bookuri = '';
            // 查找所有a元素，匹配文本
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                if (!prevUrl && (text.includes('上一章') || text.includes('上一页'))) {
                    const href = $(el).attr('href');
                    if (href) {
                        prevUrl = new URL(href, url).href;
                    }
                }
                if (!bookUrl && (text.includes('目录') || text.includes('书籍') || text.includes("章节") || text.includes('列表'))) {
                    const href = $(el).attr('href');
                    if (href) {
                        bookUrl = new URL(href, url).href;
                        bookuri = href;
                    }
                }
                if (!nextUrl && (text.includes('下一章') || text.includes('下一页'))) {
                    const href = $(el).attr('href');
                    if (href && !bookuri.includes(href)) {
                        nextUrl = new URL(href, url).href;
                    }
                }
            });
            if (!prevUrl && nextUrl) {
                vscode.window.showInformationMessage('this is the first chapter');
            }
            if (prevUrl && !nextUrl) {
                vscode.window.showInformationMessage('this is the last chapter');
            }
            if (bookUrl){
                // 查找所有a元素，匹配书籍名称, 如果href是bookurl，text则是书籍名称
                $('a').each((_, el) => {
                    if( $(el).attr('href') === bookuri ){
                        bookname = $(el).text().trim();
                        nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                        return false; // 找到后退出循环
                    }
                });
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

    // 创建状态栏项
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99999999);
    context.subscriptions.push(statusBarItem);
    
    // 获取配置
    const getConfig = (): WorkHoursConfig => {
        const config = vscode.workspace.getConfiguration('workProgress');
        return {
            workTimeProcessor: config.get<boolean>('workTimeProcessor', true),
            startHour: config.get<number>('startHour', 9),
            startMinute: config.get<number>('startMinute', 0),
            endHour: config.get<number>('endHour', 18),
            endMinute: config.get<number>('endMinute', 0),
            lunchStartHour: config.get<number>('lunchStartHour', 12),
            lunchStartMinute: config.get<number>('lunchStartMinute', 0),
            lunchEndHour: config.get<number>('lunchEndHour', 13),
            lunchEndMinute: config.get<number>('lunchEndMinute', 0)
        };
    };

    // 计算当前工作进度 (0-1)
    const calculateWorkProgress = (): number => {
        const now = new Date();
        const config = getConfig();
        
        // 转换为秒钟精度的时间
        const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
        const startSeconds = config.startHour * 3600 + config.startMinute * 60;
        const endSeconds = config.endHour * 3600 + config.endMinute * 60;
        const lunchStartSeconds = config.lunchStartHour * 3600 + config.lunchStartMinute * 60;
        const lunchEndSeconds = config.lunchEndHour * 3600 + config.lunchEndMinute * 60;
        
        // 判断是否在工作时间
        if (currentSeconds < startSeconds) return 0; // 还没上班
        if (currentSeconds >= endSeconds) return 1; // 已经下班
        
        // 计算总工作时间和已工作时间
        const totalWorkSeconds = (endSeconds - startSeconds) - (lunchEndSeconds - lunchStartSeconds);
        let workedSeconds = currentSeconds - startSeconds;
        
        // 扣除午休时间
        if (currentSeconds > lunchStartSeconds) {
            workedSeconds -= Math.min(lunchEndSeconds, currentSeconds) - lunchStartSeconds;
        }
        
        // 计算进度 (限制在0-1之间)
        return Math.min(Math.max(workedSeconds / totalWorkSeconds, 0), 1);
    };

    // 格式化剩余时间
    const formatTimeRemaining = (progress: number): string => {
        if (progress <= 0) return '还未开始';
        if (progress >= 1) return '已完成';
        
        const now = new Date();
        const config = getConfig();
        const endSeconds = config.endHour * 3600 + config.endMinute * 60;
        const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
        
        const remainingSeconds = endSeconds - currentSeconds;
        const hours = Math.floor(remainingSeconds / 3600);
        const minutes = Math.floor((remainingSeconds % 3600) / 60);
        const seconds = remainingSeconds % 60;
        
        return `${hours}时${minutes}分${seconds}秒`;
    };

    // 更新进度条显示
    const updateProgressBar = () => {
        const progress = calculateWorkProgress();
        
        // 构建细腻的进度条
        const totalBlocks = progress * PROGRESS_WIDTH;
        const fullBlocks = Math.floor(totalBlocks);
        const partialBlock = Math.floor((totalBlocks - fullBlocks) * (PROGRESS_CHARS.length - 1));
        
        const progressBar = 
            PROGRESS_CHARS[PROGRESS_CHARS.length - 1].repeat(fullBlocks) + 
            (fullBlocks < PROGRESS_WIDTH ? PROGRESS_CHARS[partialBlock] : '') +
            ' '.repeat(PROGRESS_WIDTH - fullBlocks - 1);
        
        // 设置状态栏文本
        statusBarItem.text = `$(clock):${(progress * 100).toFixed(4)}% | 剩余 ${formatTimeRemaining(progress)}`;
        
        // 根据进度设置颜色
        statusBarItem.color = progress < 0.3 ? '#4fc3f7' : 
                             progress < 0.7 ? '#dccf5eff' : '#66bb6a';
        if(vscode.workspace.getConfiguration('workProgress').get<boolean>('workTimeProcessor', true)){
            statusBarItem.show();
        }else{
            statusBarItem.hide();
        }
    };

    // 每秒更新一次
    const updateInterval = setInterval(updateProgressBar, 50);
    
    // 监听配置变化
    const configListener = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workProgress')) {
            updateProgressBar();
        }
    });

    // 注册清理函数
    context.subscriptions.push({
        dispose: () => {
            clearInterval(idleTimer)
            clearInterval(updateInterval);
            configListener.dispose();
        }
    });

    // 初始更新
    updateProgressBar();
}

export function deactivate() {
}