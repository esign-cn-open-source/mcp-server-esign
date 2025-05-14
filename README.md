# e签宝 MCP 工具

基于 Model Context Protocol (MCP) 的 e签宝电子签署工具，支持文件上传、签署流程创建、签署状态查询等功能。

## 功能特点

- 支持多种文件格式上传和自动转换为 PDF(支持本地文件路径和远程文件下载链接)：
  - PDF 文件（.pdf）
  - Word 文件（.docx, .doc, .rtf）
  - Excel 文件（.xlsx, .xls）
  - PowerPoint 文件（.pptx, .ppt）
  - WPS 文件（.wps, .et, .dps）
  - 图片文件（.jpeg, .jpg, .png, .bmp, .tiff, .tif, .gif）
  - HTML 文件（.html, .htm）
- 自动文件状态检查，确保文件处理完成
- 支持创建签署流程
- 支持查询签署流程详情
- 完整的日志记录

## 配置

在 MCP 配置中添加以下环境变量：

```json
{
  "esign-mcp": {
    "command": "npx",
    "args": ["-y", "mcp-server-esign@{version}"],
    "env": {
      "HOST": "选择对应环境：",
      "  - 测试环境：",
      "  - 沙箱环境：",
      "  - 正式环境：https://openapi.esign.cn",
      "APP_ID": "你的应用ID",
      "APP_SECRET": "你的应用密钥"
    }
  }
}
```


## 可用工具

### 1. create_sign_flow

创建签署流程，支持多种文件格式。

参数：
- `filePath`: 本地文件路径
- `fileName`: 文件名（必须包含正确的文件扩展名）
- `receiverPhone`: 签署人手机号

示例：
```json
{
  "filePath": "/path/to/contract.pdf",
  "fileName": "合同.pdf",
  "receiverPhone": "138****8000"
}
```

### 2. query_sign_flow

查询签署流程详情。

参数：
- `flowId`: 签署流程ID

示例：
```json
{
  "flowId": "12345678"
}
```

## 日志

日志文件位置：`/tmp/app.log`

日志包含以下信息：
- 文件上传记录
- 文件状态查询记录
- 错误信息

## 注意事项

1. 文件大小限制：
   - 总大小不超过 50MB
   - 单页内容不超过 20MB

2. 文件名要求：
   - 不能包含特殊字符：/ \\ : * " < > | ？
   - 不能包含 emoji 表情
   - 扩展名必须与实际文件格式一致

3. 环境说明：
   - 测试/沙箱环境：用于开发测试
   - 正式环境：用于生产部署

## 错误处理

工具会自动处理常见错误情况：
- 文件格式不支持
- 文件上传失败
- 文件转换失败
- 签署流程创建失败

所有错误都会记录在日志文件中，并返回详细的错误信息。

## License

MIT

## 相关链接

- [e签宝开放平台文档](https://open.esign.cn/doc/opendoc/pdf-sign3/rlh256)
- [Model Context Protocol](https://github.com/modelcontextprotocol)
