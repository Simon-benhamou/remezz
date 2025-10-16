import React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  AreaChart,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Bell,
  BookOpen,
  Book,
  Bug,
  LayoutGrid,
  List,
  Trash2,
  PauseCircle,
  PlayCircle,
  Plus,
  MoreHorizontal,
  Cloud,
  CheckCircle2,
  Clock3,
  Crosshair,
  Database,
  Eye,
  EyeOff,
  BarChart3,
  Download,
  FileText,
  Flame,
  Github,
  Globe,
  History,
  Info,
  Key,
  Lightbulb,
  LineChart,
  Loader2,
  Lock,
  LogOut,
  Mail,
  Maximize2,
  Minimize2,
  OctagonX,
  Pencil,
  RefreshCcw,
  RefreshCw,
  Rocket,
  Bot,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  Trophy,
  Heart,
  User,
  XCircle,
  Zap,
} from 'lucide-react';
const withClassName = (Component: React.ComponentType<any>, ...classNames: string[]) =>
  React.forwardRef<SVGSVGElement, any>((props, ref) => {
    const mergedClassName = [...classNames, props.className].filter(Boolean).join(' ');
    return <Component ref={ref} {...props} className={mergedClassName} />;
  });

export { AreaChart as AreaChartOutlined };
export { Lightbulb as BulbOutlined };
export { SlidersHorizontal as ControlOutlined };
export { BookOpen as ReadOutlined };
export { AlertTriangle as WarningOutlined };
export { CheckCircle2 as CheckCircleOutlined };
export { Clock3 as ClockCircleOutlined };
export { XCircle as CloseCircleOutlined };
export { RefreshCcw as ReloadOutlined };
export { Maximize2 as ExpandOutlined };
export { Minimize2 as CompressOutlined };
export { RefreshCw as SyncOutlined };
export { Info as InfoCircleOutlined };
export { ArrowDown as ArrowDownOutlined };
export { ArrowUp as ArrowUpOutlined };
export { AlertCircle as ExclamationCircleOutlined };
export { Search as SearchOutlined };
export { Download as DownloadOutlined };
export { Rocket as RocketOutlined };
export { Trophy as TrophyOutlined };
export { Flame as FireOutlined };
export { Zap as ThunderboltOutlined };
export { Wrench as ToolOutlined };
export { Bell as BellOutlined };
export { Bug as BugOutlined };
export const LoadingOutlined = withClassName(Loader2, 'lucide-spin');
export { ArrowLeftRight as SwapOutlined };
export { History as HistoryOutlined };
export { Crosshair as AimOutlined };
export { LineChart as LineChartOutlined };
export { Cloud as CloudOutlined };
export { Database as DatabaseOutlined };
export { Eye as EyeOutlined };
export { BarChart3 as BarChartOutlined };
export { User as UserOutlined };
export { Lock as LockOutlined };
export { Globe as GoogleOutlined };
export { Github as GithubOutlined };
export { Settings as SettingOutlined };
export { LogOut as LogoutOutlined };
export { Pencil as EditOutlined };
export { Mail as MailOutlined };
export { Key as KeyOutlined };
export { LayoutGrid as AppstoreOutlined };
export { List as BarsOutlined };
export { Trash2 as DeleteOutlined };
export { PauseCircle as PauseCircleFilled };
export { PlayCircle as PlayCircleFilled };
export { Plus as PlusOutlined };
export { MoreHorizontal as MoreOutlined };
export { FileText as FileTextOutlined };
export { Heart as HeartOutlined };
export { Book as BookOutlined };
export { Bot as RobotOutlined };
export { EyeOff as EyeInvisibleOutlined };
export { ShieldCheck as SafetyOutlined };
export { AlertCircle as AlertOutlined };
export { PauseCircle as PauseCircleOutlined };
export { OctagonX as StopOutlined };
