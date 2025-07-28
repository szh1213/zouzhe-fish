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
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Novel Reader extension is now active!');

    // 状态文件路径
    const stateFilePath = path.join(context.globalStorageUri.fsPath, 'readingState.json');
    
    // 确保目录存在
    if (!fs.existsSync(context.globalStorageUri.fsPath)) {
        fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    }

    let novelStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    novelStatusBarItem.command = 'zouzhe-fish.nextContent';
    let nextChapterBtnBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 3);
    nextChapterBtnBarItem.command = 'zouzhe-fish.nextChapter';
    nextChapterBtnBarItem.text = '$(chevron-right)';
    nextChapterBtnBarItem.show();
    context.subscriptions.push(novelStatusBarItem);

    const wordsPerSegment = 30;
    // let currentUrl = 'https://www.xblqugex.cc/book_41834250/35270823.html';
    let currentUrl = 'http://www.2wxss.com/book/113462/44451754.html';
    let prevUrl = '';
    let nextUrl = '';
    let fullText = '';
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
        const state: ReadingState = {
            url: currentUrl,
            position: currentPosition
        };
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
            
            //从#container > div > div > div.reader-main > h1标签提取章节标题
            let chapterTitle = $('div.reader-main').find('h1').text() || '未知章节';
            //从#container > div > div > div.reader-main > div.content 提取章节内容
            let content = $('div.reader-main').find('div.content').text() || '暂无内容';
            //提取上一章和下一章链接
            const prevChapterLink = $('div.reader-main').find('div').first().find('a').eq(1).attr('href');
            if (prevChapterLink) {
                prevUrl = new URL(prevChapterLink, url).href;
            }else{
                vscode.window.showInformationMessage('this is the first chapter');
            }
            const nextChapterLink = $('div.reader-main').find('div').first().find('a').eq(3).attr('href');
            if (nextChapterLink) {
                nextUrl = new URL(nextChapterLink, url).href;
            }else{
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
        novelStatusBarItem.text = `[${chapterNumber}]${segment} [${currentPosition/wordsPerSegment}/${Math.round(fullText.length/wordsPerSegment)}]`;
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
    const nextContentCommand = vscode.commands.registerCommand('zouzhe-fish.nextContent', () => {
        if (currentPosition >= fullText.length) {
            vscode.window.showInformationMessage('this is the end of the chapter');
            return;
        }
        updateStatusBar();
    });
    const prevContentCommand = vscode.commands.registerCommand('zouzhe-fish.prevContent', () => {
        if (currentPosition <= 0) {
            vscode.window.showInformationMessage('this is the beginning of the chapter');
            return;
        }
        currentPosition = Math.max(currentPosition - wordsPerSegment, 0);
        updateStatusBar(-1);
    });

    const startReadingCommand = vscode.commands.registerCommand('zouzhe-fish.startReading', async () => {
        const url = await vscode.window.showInputBox({
            placeHolder: '输入小说章节URL',
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
        stopReadingCommand
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