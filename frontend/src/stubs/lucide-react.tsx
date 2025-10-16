import React from 'react';

type IconProps = React.SVGProps<SVGSVGElement>;

const createIcon = () => {
  const Icon: React.FC<IconProps> = ({ width = 24, height = 24, strokeWidth = 1.8, ...rest }) => (
    <svg
      width={width}
      height={height}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      <rect x="3" y="3" width="18" height="18" rx="5" ry="5" opacity={0.12} />
      <path d="M8 12h8" />
      <path d="M12 8v8" opacity={0.6} />
    </svg>
  );
  Icon.displayName = 'LucideIconStub';
  return Icon;
};

const BaseIcon = createIcon();

export const Activity = BaseIcon;
export const AlertCircle = BaseIcon;
export const AlertTriangle = BaseIcon;
export const AreaChart = BaseIcon;
export const ArrowDown = BaseIcon;
export const ArrowLeftRight = BaseIcon;
export const ArrowUp = BaseIcon;
export const BarChart3 = BaseIcon;
export const Bell = BaseIcon;
export const Book = BaseIcon;
export const BookOpen = BaseIcon;
export const Bot = BaseIcon;
export const Bug = BaseIcon;
export const CheckCircle2 = BaseIcon;
export const Clock3 = BaseIcon;
export const Cloud = BaseIcon;
export const Crosshair = BaseIcon;
export const Database = BaseIcon;
export const Download = BaseIcon;
export const Eye = BaseIcon;
export const EyeOff = BaseIcon;
export const FileText = BaseIcon;
export const Flame = BaseIcon;
export const Github = BaseIcon;
export const Globe = BaseIcon;
export const Heart = BaseIcon;
export const History = BaseIcon;
export const Info = BaseIcon;
export const Key = BaseIcon;
export const LayoutGrid = BaseIcon;
export const Lightbulb = BaseIcon;
export const LineChart = BaseIcon;
export const List = BaseIcon;
export const ListChecks = BaseIcon;
export const Loader2 = BaseIcon;
export const Lock = BaseIcon;
export const LogOut = BaseIcon;
export const Mail = BaseIcon;
export const Maximize2 = BaseIcon;
export const Minimize2 = BaseIcon;
export const MoreHorizontal = BaseIcon;
export const OctagonX = BaseIcon;
export const PauseCircle = BaseIcon;
export const Pencil = BaseIcon;
export const PlayCircle = BaseIcon;
export const Plus = BaseIcon;
export const Radio = BaseIcon;
export const RefreshCcw = BaseIcon;
export const RefreshCw = BaseIcon;
export const Rocket = BaseIcon;
export const Search = BaseIcon;
export const Settings = BaseIcon;
export const ShieldCheck = BaseIcon;
export const SlidersHorizontal = BaseIcon;
export const Trash2 = BaseIcon;
export const Trophy = BaseIcon;
export const User = BaseIcon;
export const Wrench = BaseIcon;
export const XCircle = BaseIcon;
export const Zap = BaseIcon;

export type LucideIcon = React.FC<IconProps>;

export default {
  Activity,
  AlertCircle,
  AlertTriangle,
  AreaChart,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  BarChart3,
  Bell,
  Book,
  BookOpen,
  Bot,
  Bug,
  CheckCircle2,
  Clock3,
  Cloud,
  Crosshair,
  Database,
  Download,
  Eye,
  EyeOff,
  FileText,
  Flame,
  Github,
  Globe,
  Heart,
  History,
  Info,
  Key,
  LayoutGrid,
  Lightbulb,
  LineChart,
  List,
  ListChecks,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  OctagonX,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  Radio,
  RefreshCcw,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Trophy,
  User,
  Wrench,
  XCircle,
  Zap,
};
