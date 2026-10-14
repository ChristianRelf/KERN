// A project's (or workspace's) mark: a Lucide icon, an emoji or its first
// letter, in a preset or custom colour. Stored as plain strings, so new
// icons and colours never need a migration:
//   icon:   "rocket" | "emoji:🚀" | null (letter)
//   accent: "violet" | "#4f8cff" | null

import {
  Anchor,
  Apple,
  Atom,
  Baby,
  Bike,
  Book,
  Bot,
  Brain,
  Briefcase,
  Brush,
  Bug,
  Building2,
  Cake,
  Calendar,
  Camera,
  Car,
  ChartLine,
  ChefHat,
  Cloud,
  Code,
  Coffee,
  Coins,
  Compass,
  Cpu,
  Database,
  Dog,
  Dumbbell,
  Film,
  FlaskConical,
  Flame,
  Flower2,
  Folder,
  Gamepad2,
  Gem,
  Gift,
  Globe,
  GraduationCap,
  Hammer,
  Headphones,
  Heart,
  House,
  Key,
  Landmark,
  Layers,
  Leaf,
  Lightbulb,
  Mail,
  Map as MapIcon,
  Megaphone,
  Mic,
  Moon,
  Mountain,
  Music,
  Package,
  Palette,
  PenTool,
  Plane,
  Puzzle,
  Rocket,
  Scale,
  School,
  Server,
  Shield,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Sprout,
  Star,
  Store,
  Sun,
  Target,
  Tent,
  Terminal,
  Trophy,
  Truck,
  Users,
  Wallet,
  Waves,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { Project } from "@/lib/types";

/** Icons by key, grouped loosely by theme (the order shown in pickers). */
export const PROJECT_ICONS: Record<string, LucideIcon> = {
  folder: Folder,
  globe: Globe,
  code: Code,
  terminal: Terminal,
  server: Server,
  database: Database,
  cpu: Cpu,
  cloud: Cloud,
  bot: Bot,
  bug: Bug,
  layers: Layers,
  smartphone: Smartphone,
  gamepad: Gamepad2,
  puzzle: Puzzle,
  rocket: Rocket,
  zap: Zap,
  sparkles: Sparkles,
  target: Target,
  trophy: Trophy,
  star: Star,
  flame: Flame,
  gem: Gem,
  briefcase: Briefcase,
  building: Building2,
  store: Store,
  cart: ShoppingCart,
  wallet: Wallet,
  coins: Coins,
  chart: ChartLine,
  landmark: Landmark,
  scale: Scale,
  megaphone: Megaphone,
  mail: Mail,
  calendar: Calendar,
  package: Package,
  truck: Truck,
  users: Users,
  graduation: GraduationCap,
  school: School,
  book: Book,
  brain: Brain,
  lightbulb: Lightbulb,
  flask: FlaskConical,
  atom: Atom,
  pen: PenTool,
  brush: Brush,
  palette: Palette,
  camera: Camera,
  film: Film,
  music: Music,
  mic: Mic,
  headphones: Headphones,
  house: House,
  key: Key,
  hammer: Hammer,
  wrench: Wrench,
  shield: Shield,
  heart: Heart,
  baby: Baby,
  dog: Dog,
  dumbbell: Dumbbell,
  bike: Bike,
  car: Car,
  plane: Plane,
  map: MapIcon,
  compass: Compass,
  tent: Tent,
  mountain: Mountain,
  waves: Waves,
  anchor: Anchor,
  sun: Sun,
  moon: Moon,
  leaf: Leaf,
  sprout: Sprout,
  flower: Flower2,
  apple: Apple,
  coffee: Coffee,
  chef: ChefHat,
  cake: Cake,
  gift: Gift,
};

/** The app-wide accent choices (Settings → Appearance); also project colours. */
export const ACCENTS: Record<string, string> = {
  blue: "#8aa9dc",
  violet: "#a597dd",
  green: "#8bb795",
  amber: "#d2ad73",
  rose: "#cf929d",
  teal: "#7bb5ae",
};

/** Every preset colour a project or workspace can use. */
export const PROJECT_COLORS: Record<string, string> = {
  ...ACCENTS,
  sky: "#7fc3e3",
  indigo: "#8c94e6",
  plum: "#c38fd0",
  pink: "#e391bd",
  red: "#e08a80",
  orange: "#e3a072",
  sand: "#cdbb93",
  lime: "#a9c77c",
  mint: "#86cfb3",
  slate: "#9aa5b4",
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The display colour for a stored accent (preset key or #rrggbb). */
export function accentColor(accent: string | null | undefined): string | undefined {
  if (!accent) return undefined;
  return PROJECT_COLORS[accent] ?? (HEX.test(accent) ? accent : undefined);
}

export const isCustomColor = (accent: string | null | undefined) => !!accent && HEX.test(accent);

/** The emoji of an "emoji:…" icon, if it is one. */
export function iconEmoji(icon: string | null | undefined): string | null {
  return icon?.startsWith("emoji:") ? icon.slice(6) || null : null;
}

export function ProjectGlyph({ project, size = 16 }: { project: Pick<Project, "name" | "icon" | "accent">; size?: number }) {
  const color = accentColor(project.accent);
  const emoji = iconEmoji(project.icon);
  if (emoji)
    return (
      <span className="project-glyph" aria-hidden style={{ width: size, height: size, fontSize: size * 0.86, lineHeight: 1 }}>
        {emoji}
      </span>
    );
  const Icon = project.icon ? PROJECT_ICONS[project.icon] : undefined;
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
