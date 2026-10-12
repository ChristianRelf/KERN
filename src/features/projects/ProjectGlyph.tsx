import {
  Book,
  Briefcase,
  Camera,
  Code,
  Dumbbell,
  FlaskConical,
  Folder,
  Gamepad2,
  Globe,
  GraduationCap,
  Heart,
  House,
  Lightbulb,
  Music,
  PenTool,
  Plane,
  Rocket,
  Server,
  ShoppingCart,
  Wrench,
  Palette,
  Leaf,
  Coins,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "@/lib/types";

export const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  globe: Globe,
  code: Code,
  server: Server,
  gamepad: Gamepad2,
  graduation: GraduationCap,
  briefcase: Briefcase,
  house: House,
  book: Book,
  heart: Heart,
  music: Music,
  camera: Camera,
  plane: Plane,
  dumbbell: Dumbbell,
  lightbulb: Lightbulb,
  rocket: Rocket,
  pen: PenTool,
  cart: ShoppingCart,
  wrench: Wrench,
  flask: FlaskConical,
  palette: Palette,
  leaf: Leaf,
  coins: Coins,
  users: Users,
};

export const ACCENTS: Record<string, string> = {
  blue: "#8aa9dc",
  violet: "#a597dd",
  green: "#8bb795",
  amber: "#d2ad73",
  rose: "#cf929d",
  teal: "#7bb5ae",
};

export function ProjectGlyph({ project, size = 16 }: { project: Pick<Project, "name" | "icon" | "accent">; size?: number }) {
  const Icon = project.icon ? PROJECT_ICONS[project.icon] : undefined;
  const color = project.accent ? ACCENTS[project.accent] : undefined;
  if (Icon)
    return (
      <span className="project-glyph" style={{ color, width: size, height: size }}>
        <Icon strokeWidth={1.75} style={{ width: size - 1, height: size - 1 }} />
      </span>
    );
  const letter = (project.name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      className="project-glyph"
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: 4,
        fontSize: size * 0.62,
        fontWeight: 650,
        background: color ? `${color}26` : "var(--hover-strong)",
        color: color ?? "var(--text-2)",
      }}
    >
      {letter}
    </span>
  );
}
