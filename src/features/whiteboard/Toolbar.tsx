import {
  ArrowRight,
  Circle,
  Download,
  FileText,
  File,
  FolderKanban,
  Frame,
  Globe,
  Hand,
  Image,
  Map as MapIcon,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  Scan,
  Shapes,
  Spline,
  Square,
  SquareCheckBig,
  SquareKanban,
  StickyNote,
  Type,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
  Ellipsis,
  RectangleHorizontal,
  Flag,
} from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Dropdown } from "@/components/ui/Menu";
import { Tooltip } from "@/components/ui/Tooltip";

export type Tool =
  | "select"
  | "hand"
  | "text"
  | "sticky"
  | "connector"
  | "task"
  | "area"
  | "link"
  | "project"
  | "board"
  | "note"
  | "milestone"
  | `shape:${"rect" | "rounded" | "circle" | "line" | "arrow"}`;

const stop = (e: React.SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

export function Toolbar({
  tool,
  onTool,
  onImage,
  onFile,
  onInsert,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  onImage: () => void;
  onFile: () => void;
  onInsert: (t: Tool) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const btn = (t: Tool, icon: typeof Type, label: string, key: string) => (
    <IconButton icon={icon} label={label} shortcut={key} tooltipSide="top" active={tool === t} onClick={() => onTool(t)} />
  );
  const shapeActive = tool.startsWith("shape:");
  return (
    <div className="wb-toolbar" role="toolbar" aria-label="Whiteboard tools" onContextMenu={stop} onDoubleClick={(e) => e.stopPropagation()}>
      {btn("select", MousePointer2, "Select", "V")}
      {btn("hand", Hand, "Hand · hold Space", "H")}
      <span className="sep" />
      {btn("text", Type, "Text card", "T")}
      {btn("sticky", StickyNote, "Sticky note", "S")}
      <Dropdown
        side="top"
        items={[
          { label: "Rectangle", icon: Square, onSelect: () => onTool("shape:rect") },
          { label: "Rounded rectangle", icon: RectangleHorizontal, onSelect: () => onTool("shape:rounded") },
          { label: "Circle", icon: Circle, onSelect: () => onTool("shape:circle") },
          { label: "Line", icon: Minus, onSelect: () => onTool("shape:line") },
          { label: "Arrow", icon: ArrowRight, onSelect: () => onTool("shape:arrow") },
        ]}
      >
        <span>
          <Tooltip content="Shape" shortcut="R" side="top">
            <button type="button" className="icon-btn" data-active={shapeActive || undefined} aria-label="Shape">
              <Shapes strokeWidth={1.75} />
            </button>
          </Tooltip>
        </span>
      </Dropdown>
      {btn("connector", Spline, "Connector — drag between objects", "C")}
      {btn("task", SquareCheckBig, "Task card", "K")}
      {btn("area", Frame, "Area", "A")}
      <Dropdown
        side="top"
        items={[
          { label: "Image…", icon: Image, onSelect: onImage },
          { label: "Link", icon: Globe, shortcut: "L", onSelect: () => onInsert("link") },
          { label: "File reference…", icon: File, onSelect: onFile },
          { type: "separator" },
          { label: "Note", icon: FileText, onSelect: () => onInsert("note") },
          { label: "Project", icon: FolderKanban, onSelect: () => onInsert("project") },
          { label: "Board", icon: SquareKanban, onSelect: () => onInsert("board") },
          { label: "Milestone", icon: Flag, onSelect: () => onInsert("milestone") },
        ]}
      >
        <span>
          <Tooltip content="Insert" side="top">
            <button type="button" className="icon-btn" aria-label="Insert">
              <Plus strokeWidth={1.75} />
            </button>
          </Tooltip>
        </span>
      </Dropdown>
      <span className="sep" />
      <IconButton icon={Undo2} label="Undo" shortcut="Mod+Z" tooltipSide="top" disabled={!canUndo} onClick={onUndo} />
      <IconButton icon={Redo2} label="Redo" shortcut="Mod+Y" tooltipSide="top" disabled={!canRedo} onClick={onRedo} />
    </div>
  );
}

export function TopBar({
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFit,
  showMap,
  onToggleMap,
  onExport,
  onImport,
}: {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFit: () => void;
  showMap: boolean;
  onToggleMap: () => void;
  onExport: (kind: "png" | "svg" | "json") => void;
  onImport: () => void;
}) {
  return (
    <div className="wb-topbar" onContextMenu={stop} onDoubleClick={(e) => e.stopPropagation()}>
      <IconButton icon={ZoomOut} label="Zoom out" shortcut="Mod+-" size="sm" onClick={onZoomOut} />
      <button type="button" className="wb-zoom" onClick={onResetZoom} title="Reset to 100%">
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon={ZoomIn} label="Zoom in" shortcut="Mod+=" size="sm" onClick={onZoomIn} />
      <IconButton icon={Scan} label="Fit to content" shortcut="Shift+1" size="sm" onClick={onFit} />
      <IconButton icon={MapIcon} label={showMap ? "Hide minimap" : "Show minimap"} size="sm" active={showMap} onClick={onToggleMap} />
      <Dropdown
        align="end"
        items={[
          { label: "Export PNG…", icon: Download, onSelect: () => onExport("png") },
          { label: "Export SVG…", icon: Download, onSelect: () => onExport("svg") },
          { label: "Export JSON…", icon: Download, onSelect: () => onExport("json") },
          { type: "separator" },
          { label: "Import JSON…", icon: Upload, onSelect: onImport },
        ]}
      >
        <IconButton icon={Ellipsis} label="Export & import" size="sm" noTooltip />
      </Dropdown>
    </div>
  );
}
