/*
 * A small line-icon set (1.6 px strokes on a 20 px grid, round caps), drawn to sit with
 * system type. Icons inherit `currentColor` and default to 16 px.
 */
import type { ReactNode, SVGProps } from "react";

type Props = SVGProps<SVGSVGElement> & { size?: number };

function make(paths: ReactNode, fill = false) {
  return function Icon({ size = 16, ...rest }: Props) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        fill={fill ? "currentColor" : "none"}
        stroke={fill ? "none" : "currentColor"}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="icon"
        {...rest}
      >
        {paths}
      </svg>
    );
  };
}

export const IconUndo = make(<path d="M7.5 5 4 8.5 7.5 12M4.5 8.5h7.25a4 4 0 0 1 0 8H9" />);
export const IconRedo = make(<path d="M12.5 5 16 8.5 12.5 12M15.5 8.5H8.25a4 4 0 0 0 0 8H11" />);
export const IconHelp = make(
  <>
    <circle cx="10" cy="10" r="7.25" />
    <path d="M8 8a2 2 0 1 1 2.8 1.83c-.5.23-.8.7-.8 1.25V11.5" />
    <circle cx="10" cy="14.2" r=".4" fill="currentColor" />
  </>,
);
export const IconPlay = make(<path d="M6.5 4.6v10.8a.6.6 0 0 0 .9.52l8.6-5.4a.6.6 0 0 0 0-1.04l-8.6-5.4a.6.6 0 0 0-.9.52Z" />, true);
export const IconPause = make(
  <>
    <rect x="5.5" y="4.5" width="3" height="11" rx=".8" />
    <rect x="11.5" y="4.5" width="3" height="11" rx=".8" />
  </>,
  true,
);
export const IconToStart = make(<path d="M5 4.5v11M15 5.2v9.6a.5.5 0 0 1-.78.42L7.5 10.42a.5.5 0 0 1 0-.84l6.72-4.8a.5.5 0 0 1 .78.42Z" />);
export const IconPrevMarker = make(<path d="m8.5 6-4 4 4 4M12.5 6.5 16 10l-3.5 3.5L9 10Z" />);
export const IconNextMarker = make(<path d="m11.5 6 4 4-4 4M7.5 6.5 11 10l-3.5 3.5L4 10Z" />);
export const IconAddMarker = make(<path d="M8 4.5 12.5 9 8 13.5 3.5 9ZM15 12.5v5M12.5 15h5" />);
export const IconSpeaker = make(<path d="M4 8h2.5L10 5v10l-3.5-3H4ZM13 7.5a3.5 3.5 0 0 1 0 5M15 5.5a6.5 6.5 0 0 1 0 9" />);
export const IconMuted = make(<path d="M4 8h2.5L10 5v10l-3.5-3H4ZM13.5 8l4 4M17.5 8l-4 4" />);
export const IconPlus = make(<path d="M10 4.5v11M4.5 10h11" />);
export const IconGraph = make(<path d="M3.5 15.5c3.5 0 4-11 7-11s3 5 6 5M3.5 3.5v12h13" />);
export const IconDuplicate = make(
  <>
    <rect x="7" y="7" width="9" height="9" rx="2" />
    <path d="M13 4.5H6.5a2 2 0 0 0-2 2V13" />
  </>,
);
export const IconTrash = make(<path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.2a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3L14 6" />);
export const IconEye = make(
  <>
    <path d="M2.5 10s2.75-5 7.5-5 7.5 5 7.5 5-2.75 5-7.5 5-7.5-5-7.5-5Z" />
    <circle cx="10" cy="10" r="2.25" />
  </>,
);
export const IconEyeOff = make(<path d="M8.2 5.2A7.7 7.7 0 0 1 10 5c4.75 0 7.5 5 7.5 5a12.6 12.6 0 0 1-1.9 2.5M12 14.6A6.9 6.9 0 0 1 10 15c-4.75 0-7.5-5-7.5-5a12.8 12.8 0 0 1 3.1-3.4M3.5 3.5l13 13" />);
export const IconChevronDown = make(<path d="m6 8 4 4 4-4" />);
export const IconChevronRight = make(<path d="m8 6 4 4-4 4" />);
export const IconExport = make(<path d="M10 12.5V3.5M6.5 7 10 3.5 13.5 7M6 9.5H5.5a1.5 1.5 0 0 0-1.5 1.5v4a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-4a1.5 1.5 0 0 0-1.5-1.5H14" />);
export const IconImport = make(<path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 13v1.5A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V13" />);
export const IconSparkles = make(<path d="M8.5 3.5 10 8l4.5 1.5L10 11l-1.5 4.5L7 11 2.5 9.5 7 8ZM15 3v3M13.5 4.5h3" />);
export const IconSliders = make(<path d="M4 6h7M15 6h1M4 14h1M9 14h7M13 4v4M7 12v4" />);
export const IconClock = make(
  <>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4l2.5 2" />
  </>,
);
export const IconGrid = make(
  <>
    <rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.4" />
    <rect x="11" y="3.5" width="5.5" height="5.5" rx="1.4" />
    <rect x="3.5" y="11" width="5.5" height="5.5" rx="1.4" />
    <rect x="11" y="11" width="5.5" height="5.5" rx="1.4" />
  </>,
);
export const IconClose = make(<path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />);
export const IconStopwatch = make(
  <>
    <circle cx="10" cy="11" r="6" />
    <path d="M10 8v3l2 1.5M8.5 3h3M15 6l1-1" />
  </>,
);
export const IconPath = make(<path d="M3.5 15c2-6 4-8 6.5-8s3 4 6.5-3" />);
export const IconSafe = make(
  <>
    <rect x="3" y="4.5" width="14" height="11" rx="1.5" />
    <rect x="5.5" y="6.75" width="9" height="6.5" rx=".8" strokeDasharray="1.6 1.6" />
  </>,
);
export const IconAlignLeft = make(<path d="M4 3.5v13M7 7h9M7 13h5" />);
export const IconAlignHCenter = make(<path d="M10 3.5v13M5 7h10M7 13h6" />);
export const IconAlignRight = make(<path d="M16 3.5v13M4 7h9M8 13h5" />);
export const IconAlignTop = make(<path d="M3.5 4h13M7 7v9M13 7v5" />);
export const IconAlignVCenter = make(<path d="M3.5 10h13M7 5v10M13 7v6" />);
export const IconAlignBottom = make(<path d="M3.5 16h13M7 4v9M13 8v5" />);
export const IconCenter = make(
  <>
    <rect x="3.5" y="3.5" width="13" height="13" rx="2" />
    <path d="M10 7v6M7 10h6" />
  </>,
);
export const IconChevronLeft = make(<path d="m12 6-4 4 4 4" />);
export const IconArrowUp = make(<path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />);
export const IconStop = make(<rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />, true);
export const IconAttach = make(<path d="M15.5 9.5 10 15a3.5 3.5 0 0 1-5-5l6-6a2.3 2.3 0 0 1 3.3 3.3l-6 6a1.1 1.1 0 0 1-1.6-1.6L12 6.4" />);
