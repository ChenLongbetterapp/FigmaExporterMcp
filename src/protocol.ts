export type FigmaCommand =
  | "get_document_info"
  | "get_selection"
  | "get_node_info"
  | "get_nodes_info"
  | "get_design_context"
  | "list_design_assets"
  | "get_node_css"
  | "read_my_design"
  | "create_rectangle"
  | "import_image"
  | "create_frame"
  | "create_text"
  | "set_fill_color"
  | "set_stroke_color"
  | "move_node"
  | "resize_node"
  | "delete_node"
  | "delete_multiple_nodes"
  | "get_styles"
  | "get_local_components"
  | "create_component_instance"
  | "get_instance_overrides"
  | "set_instance_overrides"
  | "export_node_as_image"
  | "set_corner_radius"
  | "clone_node"
  | "set_text_content"
  | "scan_text_nodes"
  | "set_multiple_text_contents"
  | "get_annotations"
  | "set_annotation"
  | "set_multiple_annotations"
  | "scan_nodes_by_types"
  | "set_layout_mode"
  | "set_padding"
  | "set_axis_align"
  | "set_layout_sizing"
  | "set_item_spacing"
  | "get_reactions"
  | "set_default_connector"
  | "create_connections"
  | "set_focus"
  | "set_selections"
  | "create_component"
  | "create_component_set"
  | "insert_svg"
  | "set_component_property"
  | "set_component_property_references"
  | "create_variable_collection"
  | "create_variable"
  | "set_variable_value"
  | "set_variable_mode_name"
  | "bind_variable"
  | "set_opacity"
  | "set_visibility"
  | "set_text_style"
  | "set_effects"
  | "create_ellipse"
  | "create_line"
  | "flatten_node"
  | "create_boolean_operation"
  | "batch_create"
  | "get_local_variables"
  | "set_node_name"
  | "group_nodes"
  | "convert_to_component"
  | "create_icon_component";


export interface CommandProgressUpdate {
  type: 'command_progress';
  commandId: string;
  commandType: string;
  status: 'started' | 'in_progress' | 'completed' | 'error';
  progress: number;
  totalItems: number;
  processedItems: number;
  currentChunk?: number;
  totalChunks?: number;
  chunkSize?: number;
  message: string;
  payload?: any;
  timestamp: number;
}


export interface setInstanceOverridesResult { success: boolean; message: string; totalCount?: number; results?: Array<{ success: boolean; instanceId: string; instanceName: string; appliedCount?: number; message?: string; }>; }
