# 工具能力与边界

工具的当前参数 schema 直接来自 MCP `tools/list`：

```bash
/Users/dp1_dev2/Documents/Skills/figma-exporter-mcp/scripts/run.sh tools
```

| 分组 | 主要工具 | 使用场景 |
| --- | --- | --- |
| 文件 | `get_connected_files`, `set_active_file` | 发现插件连接、固定本会话文件 |
| 文档与图层 | `get_document_info`, `get_design_context`, `get_node_info`, `get_nodes_info`, `get_selection` | 页面索引、层级、布局、几何和当前选择 |
| 样式与元数据 | `get_node_css`, `get_styles`, `get_local_variables`, `get_local_components`, `get_instance_overrides` | 字体、颜色、布局、局部变量、组件和实例 |
| 扫描 | `list_design_assets`, `scan_text_nodes`, `scan_nodes_by_types`, `get_annotations`, `get_reactions` | 资源、文字、类型、标注与原型交互 |
| 资源导出 | `export_node_as_image`, `export_design_assets` | 单节点 PNG/JPG/SVG/PDF；按已识别节点集合导出 PNG |
| 节点编辑 | `create_frame`, `create_rectangle`, `create_text`, `clone_node`, `set_node_name`, `move_node`, `resize_node` | 创建和调整精确节点 |
| 文字与视觉 | `set_text_content`, `set_multiple_text_contents`, `set_text_style`, `set_fill_color`, `set_stroke_color`, `set_effects` | 内容、字体、颜色和效果 |
| 布局与组件 | `set_layout_mode`, `set_padding`, `set_item_spacing`, `create_component`, `create_component_instance`, `create_component_set` | Auto Layout、组件、变体与实例 |
| 变量 | `create_variable_collection`, `create_variable`, `set_variable_value`, `bind_variable` | 局部设计变量及绑定 |
| 组合操作 | `batch_create`, `group_nodes`, `flatten_node`, `create_boolean_operation`, `convert_to_component` | 多节点操作；部分操作会替换原节点 ID |
| 删除和显隐 | `delete_node`, `delete_multiple_nodes`, `set_visibility`, `set_opacity` | 按明确用户范围操作；不能由读取任务推导删除授权 |

完整目录为69个工具，并非表格中的示例名称集合。插件内存在但未注册为 MCP 工具的命令不能直接用 `call` 调用。此桥接没有实现文件分享、评论管理或任意脚本执行。

## 读取语义

`get_design_context` 支持 `selection`、`current_page`、`all_pages`，以及 `pageIds`；单节点精读使用 `get_node_info`。默认排除隐藏节点，旧 `includeInvisible` 参数被忽略。样式与变量保留原始元数据及可获取的文本分段，不猜测缺失信息。

`get_node_css` 用于 Web 辅助，不作为 Android/Compose 的数值转换器。业务需求和文案来源由目标项目规则决定。

## 导出语义

先 `list_design_assets`，再按节点 ID/页面/类型缩小导出范围。识别到的 screen 并不都是需要进入项目的图片，避免把文字和结构 UI 烘焙成整页切图。

- 单节点支持显式格式和倍率；批量工具目前只导出 PNG。
- Android 批量模式固定4倍，适合项目明确要求4x的图标；插画3x应使用单节点显式倍率。
- Web 使用尺寸相关倍率，并限制最大边和像素量，较大画板可小于1倍。
- 批量回执含 `exported`、`failed`、`missingNodeIds`，出现部分失败不能当作全量成功。
- 全局客户端保存图像实际字节，返回路径、类型和字节数。验收仍须核对真实文件尺寸、非空及解码结果。

Figma 图像导出的 API 定义见 [exportAsync](https://developers.figma.com/docs/plugins/api/properties/nodes-exportasync/)。
