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

type SourceType = 'url' | 'local';

interface LocalChapter {
    title: string;
    content: string;
}

interface ReadingState {
    url: string;
    position: number;
    sourceType?: SourceType;
    localFilePath?: string;
    localChapterIndex?: number;
    bookshelf: Array<{
        bookname: string;
        chapterurl: string;
        position?: number; // 可选字段，表示书签位置
        chapterIndex?: number; // 可选字段，本地文件的章节索引
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

    // 本地文件模式相关变量
    let sourceType: SourceType = 'url';
    let localFilePath: string = '';
    let localChapters: LocalChapter[] = [];
    let currentChapterIndex: number = 0;
  
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
            sourceType: sourceType,
            localFilePath: localFilePath,
            localChapterIndex: currentChapterIndex,
            bookshelf: [{
                bookname: bookname,
                chapterurl: currentUrl,
                position: currentPosition, // 保存当前章节位置
                chapterIndex: currentChapterIndex // 保存本地文件章节索引
            }]
        };
        if (state) {
            stateObject = state;
            stateObject.url = currentUrl;
            stateObject.position = currentPosition;
            stateObject.sourceType = sourceType;
            stateObject.localFilePath = localFilePath;
            stateObject.localChapterIndex = currentChapterIndex;
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
                position: currentPosition, // 保存当前章节位置
                chapterIndex: currentChapterIndex // 保存本地文件章节索引
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


    // 解析本地txt文件，提取书名和所有章节
    const parseLocalTxtFile = (filePath: string): { bookname: string; chapters: LocalChapter[] } => {
        const rawBuffer = fs.readFileSync(filePath);
        const detected = jschardet.detect(rawBuffer);
        const encoding = detected.encoding || 'utf-8';
        const rawContent = iconv.decode(rawBuffer, encoding);
        const lines = rawContent.split(/\r?\n/);

        // 解析元数据中的书名
        let bookname = '未知书籍';
        for (const line of lines) {
            if (line.startsWith('书名：') || line.startsWith('書名：')) {
                bookname = line.replace(/^[書书]名[：:]/, '').trim();
                break;
            }
        }

        // 找到分隔符后的正文起始行
        let contentStartLine = 0;
        for (let i = 0; i < lines.length; i++) {
            if (/^={10,}/.test(lines[i].trim())) {
                contentStartLine = i + 1;
                break;
            }
        }

        // 按章节标题拆分
        const chapters: LocalChapter[] = [];
        let currentTitle = '';
        let currentContentLines: string[] = [];

        for (let i = contentStartLine; i < lines.length; i++) {
            const line = lines[i];
            // 匹配中文数字或阿拉伯数字的章节标题，如 "第1章 xxx" 或 "第一章 xxx"
            const chapterMatch = line.trim().match(/^第[\d零一二三四五六七八九十百千万]+章\s+.+/);
            if (chapterMatch) {
                // 保存上一章
                if (currentTitle) {
                    chapters.push({
                        title: currentTitle,
                        content: currentContentLines.join('\n').trim()
                    });
                }
                currentTitle = chapterMatch[0].trim();
                currentContentLines = [];
            } else if (currentTitle) {
                currentContentLines.push(line);
            }
        }
        // 保存最后一章
        if (currentTitle) {
            chapters.push({
                title: currentTitle,
                content: currentContentLines.join('\n').trim()
            });
        }

        return { bookname, chapters };
    };

    // 获取本地文件当前章节内容（格式化）
    const getLocalChapterContent = (): string => {
        const chapter = localChapters[currentChapterIndex];
        if (!chapter) { return ''; }
        // 清理内容
        let content = chapter.content.replace(/\s+/g, ' ').trim();
        chapterTitle = chapter.title;
        chapterNumber = chapter.title.match(/第([零一二三四五六七八九十百千万\d]+)(?:章|节)/)?.[1] || '未知章节号';
        return `【${chapterTitle}】${content}【${chapterTitle}】`;
    };

    // 获取章节内容并解析标题
    const fetchNovelContent = async (url: string) => {
        // 本地文件模式：直接返回当前章节内容
        if ((sourceType as SourceType) === 'local') {
            const content = getLocalChapterContent();
            prevUrl = currentChapterIndex > 0 ? localFilePath : '';
            nextUrl = currentChapterIndex < localChapters.length - 1 ? localFilePath : '';
            if (!prevUrl && nextUrl) {
                vscode.window.showInformationMessage('this is the first chapter');
            }
            if (prevUrl && !nextUrl) {
                vscode.window.showInformationMessage('this is the last chapter');
            }
            return content;
        }

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
            
            chapterTitle = $('body').find('h1').last().text().replace(/\s+/g, ' ').trim() || '未知章节';
            chapterNumber = chapterTitle.match(/第([零一二三四五六七八九十百千万\d]+)(?:章|节)/)?.[1] || '未知章节号';
            
            // 获取章节内容 — 多种策略适配不同网站
            let content = '';

            // 策略0: 检测 AJAX 动态加载模式（如 hushuge.com）
            // 查找 script 中的 $.ajax 调用，直接请求 API 获取内容
            const allScripts = $('script').map((_, el) => $(el).html() || '').get().join('\n');
            const ajaxMatch = allScripts.match(/\$\.ajax\s*\(\s*\{[\s\S]*?\}\s*\)/);
            let ajaxArticleId = '';
            let ajaxPreCid = '';
            let ajaxNextCid = '';
            if (ajaxMatch) {
                const ajaxBlock = ajaxMatch[0];
                const apiUrl = ajaxBlock.match(/url\s*:\s*["']([^"']+)["']/)?.[1];
                if (apiUrl) {
                    const dataBlock = ajaxBlock.match(/data\s*:\s*\{([^}]+)\}/);
                    if (dataBlock) {
                        const params = new URLSearchParams();
                        const pairs = dataBlock[1].match(/(\w+)\s*:\s*["']([^"']*)["']/g);
                        if (pairs) {
                            pairs.forEach(p => {
                                const m = p.match(/(\w+)\s*:\s*["']([^"']*)["']/);
                                if (m) {
                                    params.append(m[1], m[2]);
                                    if (m[1] === 'articleid') { ajaxArticleId = m[2]; }
                                    if (m[1] === 'pre_cid') { ajaxPreCid = m[2]; }
                                    if (m[1] === 'next_cid') { ajaxNextCid = m[2]; }
                                }
                            });
                        }
                        try {
                            const apiFullUrl = new URL(apiUrl, url).href;
                            const apiRes = await axios.post(apiFullUrl, params.toString(), {
                                headers: {
                                    'Content-Type': 'application/x-www-form-urlencoded',
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
                                    'Referer': url
                                },
                                responseType: 'arraybuffer',
                                timeout: 10000
                            });
                            const apiData = Buffer.from(apiRes.data as ArrayBuffer);
                            const apiEnc = jschardet.detect(apiData);
                            const apiHtml = iconv.decode(apiData, apiEnc.encoding || 'utf-8');
                            const api$ = cheerio.load(apiHtml);
                            // API 返回的 HTML 通常用 <p> 标签包裹段落
                            const pTags = api$('p');
                            if (pTags.length > 0) {
                                content = '';
                                pTags.each((_, pEl) => {
                                    content += api$(pEl).text().trim() + ' ';
                                });
                            } else {
                                content = api$.text().trim();
                            }
                        } catch (_) {
                            // API 调用失败，继续尝试其他策略
                        }
                    }
                }
            }

            // 策略1: 优先尝试 div#content（最常见的小说网站模式）
            const contentDiv = $('#content');
            if (contentDiv.length > 0) {
                // 获取 div#content 的 HTML，移除 script 和 h1 标签
                let contentHtml = contentDiv.html() || '';
                // 移除 script 标签及其内容
                contentHtml = contentHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
                // 移除 h1 标签及其内容
                contentHtml = contentHtml.replace(/<h1[\s\S]*?<\/h1>/gi, '');
                // 将 <br> 标签替换为换行符，保留段落结构
                contentHtml = contentHtml.replace(/<br\s*\/?>/gi, '\n');
                // 用 cheerio 提取纯文本
                content = cheerio.load('<div>' + contentHtml + '</div>')('div').text();
                content = content.replace(/\n+/g, '\n').trim();
            }

            // 策略1b: 尝试 div#readercontainer（如三福小说网等移动端站点）
            if (!content || content.length < 50) {
                const readerDiv = $('#readercontainer');
                if (readerDiv.length > 0) {
                    let contentHtml = readerDiv.html() || '';
                    contentHtml = contentHtml.replace(/<script[\s\S]*?<\/script>/gi, '');
                    contentHtml = contentHtml.replace(/<h1[\s\S]*?<\/h1>/gi, '');
                    contentHtml = contentHtml.replace(/<br\s*\/?>/gi, '\n');
                    content = cheerio.load('<div>' + contentHtml + '</div>')('div').text();
                    content = content.replace(/\n+/g, '\n').trim();
                }
            }

            // 策略2: 如果 div#content 没找到或内容太短，查找包含 <p> 标签最多的元素
            if (!content || content.length < 50) {
                let maxPCount = 0;
                // 查找直接包含p标签的标签（不包括嵌套子元素中的p标签）
                $('div, section, article, main').each((_, el) => {
                    const directPTags = $(el).children('p');
                    if (directPTags.length > 0 && directPTags.length > maxPCount) {
                        maxPCount = directPTags.length;
                        content = '';
                        directPTags.each((i, pEl) => {
                            content += $(pEl).text().trim() + ' ';
                        });
                    }
                });
            }

            // 策略3: 如果仍然没找到，回退到最内层包含 <p> 标签的元素
            if (!content || content.length < 50) {
                let maxPCount = 0;
                $('div, section, article, main').each((_, el) => {
                    if ($(el).children('div, section, article, main').length === 0) {
                        const pTags = $(el).find('p');
                        if (pTags.length > maxPCount) {
                            maxPCount = pTags.length;
                            content = '';
                            pTags.each((i, pEl) => {
                                content += $(pEl).text().trim() + ' ';
                            });
                        }
                    }
                });
            }

            // 策略4: 最后兜底 — 找文本最长的 div
            if (!content || content.length < 50) {
                let maxLen = 0;
                $('div, section, article, main').each((_, el) => {
                    const text = $(el).text().replace(/\s+/g, ' ').trim();
                    if (text.length > maxLen) {
                        maxLen = text.length;
                        content = text;
                    }
                });
            }
            content = content || '';

            // 查找上一章、下一章、目录链接
            prevUrl = '';
            nextUrl = '';
            bookUrl = '';
            let bookuri = '';
            // 查找所有a元素，匹配文本
            $('a').each((_, el) => {
                const text = $(el).text().trim();
                const href = $(el).attr('href');
                if (!href || href.startsWith('javascript')) { return; }
                if (!prevUrl && (text.includes('上一章') || text.includes('上一页'))) {
                    try { prevUrl = new URL(href, url).href; } catch (_) { }
                }
                if (!bookUrl && !text.includes('上一章') && !text.includes('下一章') &&
                    (text.includes('目录') || text.includes('书籍') || text.includes("章节") || text.includes('列表'))) {
                    try { bookUrl = new URL(href, url).href; bookuri = href; } catch (_) { }
                }
                if (!nextUrl && (text.includes('下一章') || text.includes('下一页'))) {
                    if (!bookuri || !bookuri.includes(href)) {
                        try { nextUrl = new URL(href, url).href; } catch (_) { }
                    }
                }
            });

            // 如果上一章/下一章链接是 javascript:;（dummy），尝试从脚本 updateNav() 中提取
            if ((!prevUrl || prevUrl.startsWith('javascript')) && (!nextUrl || nextUrl.startsWith('javascript'))) {
                const updateNavMatch = allScripts.match(/updateNav\s*\(\s*["']([^"']*)["']\s*,\s*["']([^"']*)["']\s*\)/);
                if (updateNavMatch) {
                    if (updateNavMatch[1] && updateNavMatch[1] !== '/book/') {
                        try {
                            const extractedPrev = new URL(updateNavMatch[1], url).href;
                            if (!prevUrl || prevUrl.startsWith('javascript')) {
                                prevUrl = extractedPrev;
                            }
                        } catch (_) { }
                    }
                    if (updateNavMatch[2] && updateNavMatch[2] !== '/book/') {
                        try {
                            const extractedNext = new URL(updateNavMatch[2], url).href;
                            if (!nextUrl || nextUrl.startsWith('javascript')) {
                                nextUrl = extractedNext;
                            }
                        } catch (_) { }
                    }
                }
                // 如果 updateNav 中 nextUrl 是 /book/ 目录页，尝试用 ajaxNextCid 构造章节链接
                if (ajaxNextCid && ajaxNextCid !== '0' && ajaxArticleId && (!nextUrl || nextUrl.startsWith('javascript') || nextUrl === bookUrl)) {
                    const urlPath = url.replace(/\/[^/]*\.html$/, '');
                    const match = urlPath.match(/^(.*\/read\/\d+\/)/);
                    if (match) {
                        nextUrl = match[1] + ajaxNextCid + '.html';
                    }
                }
                if (ajaxPreCid && ajaxPreCid !== '0' && ajaxArticleId && (!prevUrl || prevUrl.startsWith('javascript'))) {
                    const urlPath = url.replace(/\/[^/]*\.html$/, '');
                    const match = urlPath.match(/^(.*\/read\/\d+\/)/);
                    if (match) {
                        prevUrl = match[1] + ajaxPreCid + '.html';
                    }
                }
            }

            // 三福小说网等移动端：上一章/下一章用图片代替文字，链接 id 为 funprev/funnt
            if (!prevUrl || prevUrl.startsWith('javascript')) {
                const prevHref = $('#funprev').attr('href');
                if (prevHref && !prevHref.startsWith('javascript')) {
                    try { prevUrl = new URL(prevHref, url).href; } catch (_) { }
                }
            }
            if (!nextUrl || nextUrl.startsWith('javascript')) {
                const nextHref = $('#funnt').attr('href');
                if (nextHref && !nextHref.startsWith('javascript')) {
                    try { nextUrl = new URL(nextHref, url).href; } catch (_) { }
                }
            }

            // 三福小说网等：下一章链接在 eval 混淆脚本中，尝试解码提取
            if (!nextUrl || nextUrl.startsWith('javascript')) {
                const evalMatch = allScripts.match(/eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\.split\('\|'\)\s*,\s*0\s*,\s*\{\s*\}\s*\)\)/);
                if (evalMatch) {
                    try {
                        // eslint-disable-next-line no-eval
                        const decoded = eval(evalMatch[0]) as string;
                        const urlMatch = decoded.match(/https?:\/\/[^'"]+\.html/);
                        if (urlMatch) {
                            nextUrl = urlMatch[0];
                        }
                    } catch (_) {
                        // 解码失败（如 window 未定义），从打包参数中提取
                        const arrMatch = evalMatch[0].match(/'([^']*)'\.split\('\|'\)/);
                        if (arrMatch) {
                            const parts = arrMatch[1].split('|');
                            // 打包代码格式: https://{sub}.{site}.{tld}/book/{bookId}/{chapterId}.html
                            // parts[0]=site名, parts[1]=bookId, parts[12]=subdomain, parts[13]=tld
                            const site = parts[0] || '';
                            const sub = parts[12] || '';
                            const tld = parts[13] || '';
                            const bookId = parts[1] || '';
                            // 找长随机字符串（20+字符，混合大小写和数字）作为下一章ID
                            const currentChapterId = url.match(/\/([^/]+)\.html$/)?.[1] || '';
                            for (const p of parts) {
                                if (p.length >= 20 && /[a-zA-Z]/.test(p) && /\d/.test(p) && p !== currentChapterId) {
                                    nextUrl = `https://${sub}.${site}.${tld}/book/${bookId}/${p}.html`;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            if (!prevUrl && nextUrl) {
                vscode.window.showInformationMessage('this is the first chapter');
            }
            if (prevUrl && !nextUrl) {
                vscode.window.showInformationMessage('this is the last chapter');
            }
            if (bookUrl){
                // 查找所有a元素，匹配书籍名称, 如果href是bookurl，text则是书籍名称
                $('a').each((_, el) => {
                    if( $(el).attr('href') === bookuri || $(el).attr('href') === bookUrl ){
                        bookname = $(el).text().trim();
                        nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                        if (! bookname.includes("目录")){
                            return false; // 找到后退出循环
                        }
                    }
                });
            }
            // 清理内容：移除分页标记、多余空白
            content = content.replace(/\(?第\d+\/\d+页\)?/g, '');
            content = content.replace(/（本章节未完结，点击下一页翻页继续阅读）/g, '');
            content = content.replace(/\s+/g, ' ').trim();
            // 清理标题中的页码后缀
            chapterTitle = chapterTitle.replace(/（第\d+页）$/, '').trim();
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
        if ((sourceType as SourceType) === 'local') {
            if (currentChapterIndex > 0) {
                currentChapterIndex--;
                fullText = await fetchNovelContent(currentUrl);
                currentPosition = -wordsPerSegment;
                nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                updateStatusBar();
            } else {
                vscode.window.showInformationMessage('this is the first chapter');
            }
            return;
        }
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
        if ((sourceType as SourceType) === 'local') {
            if (currentChapterIndex < localChapters.length - 1) {
                currentChapterIndex++;
                fullText = await fetchNovelContent(currentUrl);
                currentPosition = -wordsPerSegment;
                nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                updateStatusBar();
            } else {
                vscode.window.showInformationMessage('this is the last chapter');
            }
            return;
        }
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
                chapterIndex: book.chapterIndex || 0, // 本地文件章节索引
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
                    // 检测是否为本地文件
                    if (!selected.description.startsWith('http://') && !selected.description.startsWith('https://') && fs.existsSync(selected.description)) {
                        sourceType = 'local' as SourceType;
                        localFilePath = selected.description;
                        const parsed = parseLocalTxtFile(localFilePath);
                        localChapters = parsed.chapters;
                        currentChapterIndex = selected.chapterIndex || 0;
                        if (currentChapterIndex >= localChapters.length) {
                            currentChapterIndex = 0;
                        }
                        fullText = getLocalChapterContent();
                        nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                        updateStatusBar();
                    } else {
                        sourceType = 'url' as SourceType;
                        fetchNovelContent(currentUrl).then(content => {
                            fullText = content;
                            updateStatusBar();
                        }).catch(error => {
                            vscode.window.showErrorMessage('加载书籍内容失败: ' + (error as Error).message);
                        });
                    }
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
            placeHolder: '输入章节URL或本地txt文件路径',
            value: currentUrl
        });
        
        if (url) {
            // 检测是否为本地文件路径（非 http/https 开头）
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                // 尝试作为本地文件路径处理
                const resolvedPath = path.resolve(url);
                if (fs.existsSync(resolvedPath) && resolvedPath.endsWith('.txt')) {
                    try {
                        sourceType = 'local' as SourceType;
                        localFilePath = resolvedPath;
                        const parsed = parseLocalTxtFile(resolvedPath);
                        bookname = parsed.bookname;
                        localChapters = parsed.chapters;
                        if (localChapters.length === 0) {
                            vscode.window.showErrorMessage('未能在文件中找到任何章节，请确认文件格式');
                            return;
                        }
                        currentChapterIndex = 0;
                        currentUrl = resolvedPath;
                        fullText = await fetchNovelContent(resolvedPath);
                        currentPosition = -wordsPerSegment;
                        nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                        updateStatusBar();
                        vscode.window.showInformationMessage(`已加载本地小说《${bookname}》，共 ${localChapters.length} 章`);
                        return;
                    } catch (error) {
                        vscode.window.showErrorMessage('读取本地文件失败: ' + (error as Error).message);
                        return;
                    }
                } else {
                    vscode.window.showErrorMessage('文件不存在或不是.txt文件，请输入有效路径或URL');
                    return;
                }
            }

            // URL 模式
            sourceType = 'url' as SourceType;
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
                // 检测是否为本地文件模式
                if (state.sourceType === 'local' && state.localFilePath && fs.existsSync(state.localFilePath)) {
                    sourceType = 'local' as SourceType;
                    localFilePath = state.localFilePath;
                    currentChapterIndex = state.localChapterIndex || 0;
                    const parsed = parseLocalTxtFile(localFilePath);
                    bookname = parsed.bookname;
                    localChapters = parsed.chapters;
                    if (currentChapterIndex >= localChapters.length) {
                        currentChapterIndex = 0;
                    }
                    currentUrl = state.url;
                    fullText = await fetchNovelContent(currentUrl);
                    currentPosition = Math.min(state.position, fullText.length);
                    nextChapterBtnBarItem.tooltip = `《${bookname}》${chapterTitle}`;
                    updateStatusBar();
                    return;
                }
                // URL 模式（默认）
                sourceType = 'url' as SourceType;
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
        if (currentSeconds < startSeconds) {
            return 0; // 还没上班
        }
        if (currentSeconds >= endSeconds){
            return 1; // 已经下班
        }
        
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
        if (progress <= 0) {
            return '还未开始';
        }
        if (progress >= 1) {
            return '已完成';
        }
        
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
            clearInterval(idleTimer);
            clearInterval(updateInterval);
            configListener.dispose();
        }
    });

    // 初始更新
    updateProgressBar();
}

export function deactivate() {
}