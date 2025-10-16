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
export const Bot = BaseIcon;
export const Lightbulb = BaseIcon;
export const ListChecks = BaseIcon;
export const Radio = BaseIcon;
export const Zap = BaseIcon;

export type LucideIcon = React.FC<IconProps>;

export default {
  Activity,
  Bot,
  Lightbulb,
  ListChecks,
  Radio,
  Zap,
};
