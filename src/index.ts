#!/usr/bin/env node

import {Server} from "@modelcontextprotocol/sdk/server/index.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";
import {CallToolRequestSchema, ListToolsRequestSchema} from "@modelcontextprotocol/sdk/types.js";
import fetch from 'node-fetch';
import FormData from 'form-data';
import fs from 'fs';
import crypto from 'crypto';

function logToFile(message: string) {
    const logFilePath = '/tmp/app.log';
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${message}\n`);
}


// 从环境变量获取配置
const config = {
    host: process.env.HOST || '',
    appId: process.env.APP_ID  || '',
    appSecret: process.env.APP_SECRET  || ''
};

// 验证配置
function validateConfig() {
    const missingConfigs = [];

    if (!config.host) {
        missingConfigs.push('HOST');
    }
    if (!config.appId) {
        missingConfigs.push('APP_ID');
    }
    if (!config.appSecret) {
        missingConfigs.push('APP_SECRET');
    }

    if (missingConfigs.length > 0) {
        return {
            content: [{
                type: "text",
                text: `配置错误：缺少必要的配置项 ${missingConfigs.join(', ')}

请在 MCP 配置中添加以下环境变量：
{
  "esign-mcp": {
    "command": "npx",
    "args": ["-y", "${process.argv[1]}"],
    "env": {
      ${!config.host ? `"HOST": "选择以下环境之一：",
      "  - 测试环境：",
      "  - 沙箱环境：",
      "  - 正式环境：https://openapi.esign.cn",` : ''}
      ${!config.appId ? `"APP_ID": "你的应用ID",` : ''}
      ${!config.appSecret ? `"APP_SECRET": "你的应用密钥",` : ''}
    }
  }
}

说明：
1. HOST：选择对应的环境地址
   - 测试环境：
   - 沙箱环境：
   - 正式环境：https://openapi.esign.cn
2. APP_ID：在 e签宝开放平台获取的应用ID
3. APP_SECRET：在 e签宝开放平台获取的应用密钥

注意：正式环境和沙箱环境需要使用对应环境的 APP_ID 和 APP_SECRET`
            }]
        };
    }
    return null;
}

// API 响应类型定义
interface ApiResponse<T> {
    code: number;
    message: string;
    data: T;
}

interface SignFlowResponse {
    signFlowId: string;
}

interface SignRequest {
    filePath: string;  // 本地文件路径
    fileName: string;  // 文件名
    receiverPhone: string;  // 接收方手机号
    username : string
}

interface SignFlowDetailResponse {
    signFlowStatus: number;
    signFlowDescription: string;
    signFlowCreateTime: number;
    signFlowStartTime: number;
    signFlowFinishTime: number | null;
    docs: Array<{
        fileId: string;
        fileName: string;
    }>;
    signers: Array<{
        psnSigner?: {
            psnName: string;
            psnAccount: {
                accountMobile: string;
                accountEmail: string | null;
            };
        };
        signerType: number;
        signOrder: number;
        signStatus: number;
    }>;
}

// 文件状态枚举
enum FileStatus {
    NOT_UPLOAD = 0,        // 文件未上传
    UPLOADING = 1,         // 文件上传中
    UPLOAD_COMPLETE = 2,   // 文件上传已完成 或 文件已转换（HTML）
    UPLOAD_FAILED = 3,     // 文件上传失败
    WAITING_CONVERT = 4,   // 文件等待转换（PDF）
    CONVERT_COMPLETE = 5,  // 文件已转换（PDF）
    WATERMARKING = 6,      // 加水印中
    WATERMARK_COMPLETE = 7,// 加水印完毕
    CONVERTING = 8,        // 文件转化中（PDF）
    CONVERT_FAILED = 9,    // 文件转换失败（PDF）
    WAITING_HTML = 10,     // 文件等待转换（HTML）
    CONVERTING_HTML = 11,  // 文件转换中（HTML）
    CONVERT_HTML_FAILED = 12 // 文件转换失败（HTML）
}

interface FileStatusResponse {
    fileId: string;
    fileName: string;
    fileStatus: FileStatus;
    fileDownloadUrl: string;
    fileTotalPageCount: number;
}

// @ts-ignore
/**
 */
const server = new Server(
    {
        name: "esign-server",
        version: "0.1.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);

/**
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "create_sign_flow",
                description: "创建签署流程，支持多种文件格式，包括：PDF、Word、Excel、PPT、WPS、图片等。非PDF格式会自动转换为PDF。",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: {
                            type: "string",
                            description: "文件路径，支持本地文件路径或 HTTP(S) 远程文件下载链接。支持的格式：PDF(.pdf)、Word(.docx/.doc/.rtf)、Excel(.xlsx/.xls)、PPT(.pptx/.ppt)、WPS(.wps/.et/.dps)、图片(.jpg/.png/.bmp等)、HTML(.html/.htm)"
                        },
                        fileName: {
                            type: "string",
                            description: "文件名，必须包含文件扩展名（例如：合同.pdf、文档.docx），扩展名要与实际文件格式一致"
                        },
                        receiverPhone: {
                            type: "string",
                            description: "签署人手机号，用于接收签署通知短信"
                        },
                        username: {
                            type: "string",
                            description: "签署人姓名,非必填，默认为空字符串，如果对方没有在e签宝注册过, 则必须提供姓名; 如果对应用户已存在个人信息，则不需要添加姓名"
                        }
                    },
                    required: ["filePath", "fileName", "receiverPhone"]
                }
            },
            {
                name: "query_sign_flow",
                description: "Query sign flow details",
                inputSchema: {
                    type: "object",
                    properties: {
                        flowId: {
                            type: "string",
                            description: "Sign flow ID"
                        }
                    },
                    required: ["flowId"]
                }
            }
        ]
    };
});

// 计算请求签名
function calculateSignature(
    method: string,
    requestPath: string,
    contentMd5: string = '',
    contentType: string = 'application/json'
): string {
    // 1. 规范化参数
    method = String(method).toUpperCase().trim();
    requestPath = String(requestPath).split('?')[0].trim();
    if (!requestPath.startsWith('/')) {
        requestPath = '/' + requestPath;
    }

    // 2. 构建签名原文
    const accept = '*/*';
    const date = '';
    const headers = '';

    const components = [
        method,
        accept,
        contentMd5,
        contentType,
        date
    ];

    // 3. 按照Java代码的方式构建签名原文
    let signatureStr = components.join('\n') + '\n';
    if (headers === '') {
        signatureStr += requestPath;
    } else {
        signatureStr += headers + '\n' + requestPath;
    }

    // 4. 使用 HMAC-SHA256 计算签名
    const hmac = crypto.createHmac('sha256', config.appSecret);
    const signature = hmac.update(Buffer.from(signatureStr, 'utf8'))
        .digest('base64');

    // 5. 详细日志记录
    logToFile('===== 签名计算详情 =====');
    logToFile('签名原文组件:');
    logToFile(`[0]method="${method}"`);
    logToFile(`[1]accept="${accept}"`);
    logToFile(`[2]contentMd5="${contentMd5}"`);
    logToFile(`[3]contentType="${contentType}"`);
    logToFile(`[4]date="${date}"`);
    logToFile(`[5]headers="${headers}"`);
    logToFile(`[6]requestPath="${requestPath}"`);
    logToFile('签名原文(每行以[换行符]结尾):');
    logToFile(signatureStr.split('\n').map(line => `"${line}\\n"`).join('\n'));
    logToFile(`使用的 appSecret: ${config.appSecret}`);
    logToFile(`计算得到的签名: ${signature}`);
    logToFile('=====================');

    return signature;
}

// 仅计算内容的 MD5，不需要 appSecret
function calculateContentMd5(content: string | Buffer): string {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    return crypto.createHash('md5')
        .update(buffer)
        .digest('base64');
}

function getCommonHeaders(
    method: string,
    requestPath: string,
    body?: string | Buffer,
    contentType: string = 'application/json'
): Record<string, string> {
    // 1. 处理 Content-MD5
    let contentMd5 = '';
    if (body) {
        contentMd5 = calculateContentMd5(body);
    }

    logToFile("-->>> appid = " + config.appId);

    // 2. 构建基础请求头
    const headers: Record<string, string> = {
        'X-Tsign-Open-App-Id': config.appId,
        'X-Tsign-Open-Auth-Mode': 'Signature',
        'Accept': '*/*',
        'User-Agent': 'esign-mcp-server-typescript-V1.1.2',
        'X-Tsign-Open-Ca-Timestamp': String(Date.now())
    };

    // 3. 只有在有 body 时才添加 Content-Type
    if (body) {
        headers['Content-Type'] = contentType;
    }

    // 4. 只有在有 body 时才添加 Content-MD5
    if (contentMd5) {
        headers['Content-MD5'] = contentMd5;
    }

    // 5. 计算并添加签名
    const signature = calculateSignature(
        method,
        requestPath,
        contentMd5,
        contentType
    );
    headers['X-Tsign-Open-Ca-Signature'] = signature;

    return headers;
}


// 支持的文件格式列表
const SUPPORTED_FILE_EXTENSIONS = [
    '.pdf',  // PDF文件
    '.docx', '.doc', '.rtf',  // Word文件
    '.xlsx', '.xls',  // Excel文件
    '.pptx', '.ppt',  // PowerPoint文件
    '.wps', '.et', '.dps',  // WPS文件
    '.jpeg', '.jpg', '.png', '.bmp', '.tiff', '.tif', '.gif',  // 图片文件
    '.html', '.htm'  // HTML文件
];

// 检查文件是否支持
function isFileSupported(fileName: string): boolean {
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
    return SUPPORTED_FILE_EXTENSIONS.includes(ext);
}

// 下载远程文件到临时目录
async function downloadFile(url: string): Promise<{ filePath: string; cleanup: () => void }> {
    // 创建临时文件名
    const tempDir = '/tmp';
    const tempFileName = `download-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const tempFilePath = `${tempDir}/${tempFileName}`;

    logToFile(`开始下载远程文件: ${url} -> ${tempFilePath}`);

    try {
        // 下载文件
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`下载失败: ${response.statusText}`);
        }

        // 将响应内容写入临时文件
        const fileStream = fs.createWriteStream(tempFilePath);
        const buffer = await response.buffer();
        await new Promise((resolve, reject) => {
            fileStream.write(buffer, (error) => {
                if (error) reject(error);
                else resolve(null);
            });
        });
        fileStream.close();

        logToFile(`文件下载完成: ${tempFilePath}`);

        // 返回临时文件路径和清理函数
        return {
            filePath: tempFilePath,
            cleanup: () => {
                try {
                    fs.unlinkSync(tempFilePath);
                    logToFile(`临时文件已删除: ${tempFilePath}`);
                } catch (err) {
                    logToFile(`删除临时文件失败: ${tempFilePath}, 错误: ${err}`);
                }
            }
        };
    } catch (error) {
        logToFile(`下载文件失败: ${error}`);
        throw error;
    }
}

async function uploadFile(filePath: string, fileName: string): Promise<string> {
    // 检查文件格式是否支持
    if (!isFileSupported(fileName)) {
        throw new Error(`不支持的文件格式。支持的格式包括：${SUPPORTED_FILE_EXTENSIONS.join(', ')}`);
    }

    let actualFilePath = filePath;
    let cleanup: (() => void) | undefined;

    try {
        // 检查是否是远程文件
        if (filePath.startsWith('http://') || filePath.startsWith('https://')) {
            logToFile(`检测到远程文件链接: ${filePath}`);
            const downloadResult = await downloadFile(filePath);
            actualFilePath = downloadResult.filePath;
            cleanup = downloadResult.cleanup;
            logToFile(`远程文件已下载到本地: ${actualFilePath}`);
        }

        // 步骤一：获取文件上传地址
        const fileSize = fs.statSync(actualFilePath).size;
        const fileBuffer = fs.readFileSync(actualFilePath);
        const contentMd5 = calculateContentMd5(fileBuffer);
        const isPDF = fileName.toLowerCase().endsWith('.pdf');
        const isHTML = fileName.toLowerCase().match(/\.(html|htm)$/);

        const requestPath = '/v3/files/file-upload-url';
        const requestBody = JSON.stringify({
            contentMd5,
            contentType: isPDF ? 'application/pdf' : 'application/octet-stream',
            fileName,
            fileSize,
            convertToPDF: !isPDF,
            convertToHTML: isHTML ? false : undefined
        });

        logToFile(`上传文件请求参数:\ncontentMd5=${contentMd5}\nfileSize=${fileSize}`);

        const headers = getCommonHeaders('POST', requestPath, requestBody, 'application/json; charset=UTF-8');

        logToFile("headers " + JSON.stringify(headers))
        const response = await fetch(`${config.host}${requestPath}`, {
            method: 'POST',
            headers: headers,
            body: requestBody
        });

        const responseText = await response.text();
        logToFile(`上传文件响应:\n${responseText}`);

        const result = JSON.parse(responseText) as ApiResponse<{
            fileId: string;
            fileUploadUrl: string;
        }>;

        if (result.code !== 0) {
            throw new Error(`Failed to get upload URL: ${result.message}`);
        }

        // 步骤二：上传文件流
        const uploadResponse = await fetch(result.data.fileUploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': isPDF ? 'application/pdf' : 'application/octet-stream',
                'Content-MD5': contentMd5
            },
            body: fileBuffer
        });

        if (!uploadResponse.ok) {
            throw new Error(`Failed to upload file: ${uploadResponse.statusText}`);
        }

        // 返回文件ID
        return result.data.fileId;
    } finally {
        // 如果是远程文件，清理临时文件
        if (cleanup) {
            cleanup();
        }
    }
}

async function createSignFlow(fileId: string, receiverPhone: string, fileName: string, username : string): Promise<string> {
    const requestPath = '/v3/sign-flow/create-by-file';
    const requestBody = JSON.stringify({
        docs: [{
            fileId: fileId,
            fileName: fileName
        }],
        signFlowConfig: {
            signFlowTitle: "待签署文件",
            signFlowDesc: "请签署文件",
            signFlowEffectiveTime: Date.now(),
            signFlowExpireTime: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7天后过期
            signOrder: false, // 无序签署
            notifyType: "1", // 短信通知
            redirectUrl: "", // 可以为空
            autoFinish: true
        },
        signers: [{
            signConfig: {
                signOrder: 1,
                forcedReadingTime: "10" // 强制阅读时间10秒
            },
            noticeConfig: {
                noticeTypes: "1" // 短信通知
            },
            signerType: 0, // 个人签署
            psnSignerInfo: {
                psnAccount: receiverPhone,
                psnInfo: username === "" || username === undefined ? undefined : {
                    psnName: username === "" ? undefined : username
                }
            },
            signFields: [{
                fileId: fileId,
                signFieldType: 0,
                normalSignFieldConfig: {
                    autoSign: false,
                    freeMode: false,
                    movableSignField: false,
                    signFieldStyle: 1,
                    signFieldSize: "96",
                    signFieldPosition: {
                        positionPage: "1",
                        positionX: 100,
                        positionY: 100
                    }
                },
                signDateConfig: {
                    dateFormat: "yyyy-MM-dd",
                    showSignDate: 1,
                    signDatePositionX: 100,
                    signDatePositionY: 150
                }
            }]
        }],
        autoStart: true
    });

    debugger
    const headers = getCommonHeaders('POST', requestPath, requestBody);

    const response = await fetch(`${config.host}${requestPath}`, {
        method: 'POST',
        headers: headers,
        body: requestBody
    });

    const result = await response.json() as ApiResponse<SignFlowResponse>;
    if (result.code === 0) {
        return result.data.signFlowId;
    }
    throw new Error(`Sign flow creation failed: ${result.message}`);
}

async function getSignUrl(flowId: string, receiverPhone: string): Promise<string> {
    const requestPath = `/v3/sign-flow/${flowId}/sign-url`;
    const requestBody = JSON.stringify({
        needLogin: false,
        urlType: 2, // 签署链接
        operator: {
            psnAccount: receiverPhone
        },
        clientType: "ALL" // 自动适配移动端或PC端
    });

    const headers = getCommonHeaders('POST', requestPath, requestBody);

    logToFile(JSON.stringify(headers));

    const response = await fetch(`${config.host}${requestPath}`, {
        method: 'POST',
        headers: headers,
        body: requestBody
    });

    const result = await response.json() as ApiResponse<{
        url: string;
        shortUrl: string;
    }>;

    if (result.code === 0) {
        return result.data.shortUrl || result.data.url;
    }
    throw new Error(`Failed to get sign URL: ${result.message}`);
}

async function getSignFlowDetail(flowId: string): Promise<SignFlowDetailResponse> {
    const requestPath = `/v3/sign-flow/${flowId}/detail`;
    const headers = getCommonHeaders('GET', requestPath, 'application/json; charset=UTF-8');

    const response = await fetch(`${config.host}${requestPath}`, {
        method: 'GET',
        headers: headers
    });

    const result = await response.json() as ApiResponse<SignFlowDetailResponse>;
    if (result.code === 0) {
        return result.data;
    }
    throw new Error(`Failed to get sign flow detail: ${result.message}`);
}

// 查询文件状态
async function queryFileStatus(fileId: string): Promise<FileStatusResponse> {
    const requestPath = `/v3/files/${fileId}`;
    const headers = getCommonHeaders('GET', requestPath, 'application/json; charset=UTF-8');

    const response = await fetch(`${config.host}${requestPath}`, {
        method: 'GET',
        headers: headers
    });

    const result = await response.json() as ApiResponse<FileStatusResponse>;
    if (result.code === 0) {
        return result.data;
    }
    throw new Error(`查询文件状态失败: ${result.message}`);
}

// 等待文件处理完成
async function waitForFileProcessing(fileId: string, maxAttempts: number = 30, interval: number = 2000): Promise<void> {
    let attempts = 0;

    while (attempts < maxAttempts) {
        const status = await queryFileStatus(fileId);
        logToFile(`文件状态查询 第${attempts + 1}次: fileId=${fileId}, status=${status.fileStatus}`);

        // 状态为2或5时，文件可用于签署流程
        if (status.fileStatus === FileStatus.UPLOAD_COMPLETE ||
            status.fileStatus === FileStatus.CONVERT_COMPLETE) {
            return;
        }

        // 如果状态表示失败，立即抛出错误
        if (status.fileStatus === FileStatus.UPLOAD_FAILED ||
            status.fileStatus === FileStatus.CONVERT_FAILED ||
            status.fileStatus === FileStatus.CONVERT_HTML_FAILED) {
            throw new Error(`文件处理失败: ${status.fileStatus}`);
        }

        // 等待指定时间后继续查询
        await new Promise(resolve => setTimeout(resolve, interval));
        attempts++;
    }

    throw new Error(`文件处理超时，请稍后重试`);
}

/**
 *
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // 验证配置
    const validationResult = validateConfig();
    if (validationResult) {
        return validationResult;
    }

    switch (request.params.name) {
        case "create_sign_flow": {
            try {
                const args = request.params.arguments as unknown as SignRequest;
                const {filePath, fileName, receiverPhone, username} = args;

                logToFile(`uploadFile filePath: ${filePath} fileName: ${fileName}`);

                const fileId = await uploadFile(filePath, fileName);
                // 等待文件处理完成
                await waitForFileProcessing(fileId);

                const flowId = await createSignFlow(fileId, receiverPhone, fileName, username);
                const signUrl = await getSignUrl(flowId, receiverPhone);

                return {
                    content: [{
                        type: "text",
                        text: `Success!\nFlow ID: ${flowId}\nSign URL: ${signUrl}`
                    }]
                };
            } catch (err: any) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: ${err.message}`
                    }]
                };
            }
        }

        case "query_sign_flow": {
            try {
                const args = request.params.arguments as { flowId: string };
                const detail = await getSignFlowDetail(args.flowId);

                const statusMap: Record<number, string> = {
                    0: "草稿",
                    1: "签署中",
                    2: "完成",
                    3: "撤销",
                    5: "过期",
                    7: "拒签"
                };

                const formatTime = (timestamp: number | null) => {
                    if (!timestamp) return "未完成";
                    return new Date(timestamp).toLocaleString();
                };

                return {
                    content: [{
                        type: "text",
                        text: `签署流程详情：
状态：${statusMap[detail.signFlowStatus] || "未知"} (${detail.signFlowDescription})
创建时间：${formatTime(detail.signFlowCreateTime)}
开始时间：${formatTime(detail.signFlowStartTime)}
完成时间：${formatTime(detail.signFlowFinishTime)}
文档：${detail.docs.map(doc => doc.fileName).join(", ")}
签署人：${detail.signers.map(signer =>
                            signer.psnSigner ?
                                `${signer.psnSigner.psnName} (${signer.psnSigner.psnAccount.accountMobile})` :
                                "企业签署"
                        ).join(", ")}`
                    }]
                };
            } catch (err: any) {
                return {
                    content: [{
                        type: "text",
                        text: `Error: ${err.message}`
                    }]
                };
            }
        }

        default:
            return {
                content: [{
                    type: "text",
                    text: "Error: Unknown tool"
                }]
            };
    }
});

//
// /**
//  * 使用标准输入输出流启动服务器
//  * 这允许服务器通过标准输入输出进行通信
//  */
const transport = new StdioServerTransport();
server.connect(transport).catch(() => process.exit(1));