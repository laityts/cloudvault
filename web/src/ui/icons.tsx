import type { JSX } from 'solid-js';
import { splitProps } from 'solid-js';

type Props = Omit<JSX.SvgSVGAttributes<SVGSVGElement>, 'children'> & { size?: number | string };

/** All icons use 1.5px stroke + 24x24 viewBox so they sit consistently in the UI.
 *  Pass `size` (default 18) to control rendered size. */
function Icon(props: Props & { d: string | string[] }) {
  const [local, rest] = splitProps(props, ['size', 'd']);
  const size = local.size ?? 18;
  const paths = Array.isArray(local.d) ? local.d : [local.d];
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...rest}
    >
      {paths.map((d) => (
        <path d={d} />
      ))}
    </svg>
  );
}

export const IconMenu = (p: Props) => <Icon {...p} d="M4 6h16M4 12h16M4 18h16" />;
export const IconClose = (p: Props) => <Icon {...p} d="M18 6L6 18M6 6l12 12" />;
export const IconCheck = (p: Props) => <Icon {...p} d="M5 12.5l5 5L20 7" />;
export const IconChevronRight = (p: Props) => <Icon {...p} d="M9 6l6 6-6 6" />;
export const IconChevronLeft = (p: Props) => <Icon {...p} d="M15 6l-6 6 6 6" />;
export const IconChevronDown = (p: Props) => <Icon {...p} d="M6 9l6 6 6-6" />;
export const IconChevronUp = (p: Props) => <Icon {...p} d="M6 15l6-6 6 6" />;
export const IconPlus = (p: Props) => <Icon {...p} d={['M12 5v14', 'M5 12h14']} />;
export const IconMinus = (p: Props) => <Icon {...p} d="M5 12h14" />;
export const IconSearch = (p: Props) => (
  <Icon {...p} d={['M11 19a8 8 0 100-16 8 8 0 000 16z', 'M21 21l-4.3-4.3']} />
);
export const IconHome = (p: Props) => (
  <Icon {...p} d={['M3 11l9-8 9 8', 'M5 10v10a1 1 0 001 1h4v-6h4v6h4a1 1 0 001-1V10']} />
);
export const IconFolder = (p: Props) => (
  <Icon {...p} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
);
export const IconFolderOpen = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v1H3V7z',
      'M3 9h18l-2 9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z',
    ]}
  />
);
export const IconFolderPlus = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
      'M12 11v6',
      'M9 14h6',
    ]}
  />
);
export const IconFile = (p: Props) => <Icon {...p} d={['M14 3v5h5', 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V8l-6-5z']} />;
export const IconImage = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z',
      'M8.5 11a1.5 1.5 0 100-3 1.5 1.5 0 000 3z',
      'M21 15l-5-5L5 21',
    ]}
  />
);
export const IconVideo = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M3 7a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
      'M17 10l4-2v8l-4-2v-4z',
    ]}
  />
);
export const IconAudio = (p: Props) => (
  <Icon {...p} d={['M9 18V5l12-2v13', 'M9 18a3 3 0 11-3-3 3 3 0 013 3z', 'M21 16a3 3 0 11-3-3 3 3 0 013 3z']} />
);
export const IconPdf = (p: Props) => <Icon {...p} d={['M14 3v5h5', 'M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V8l-6-5z', 'M8 13h1.5a1.5 1.5 0 010 3H8v-3z', 'M8 16v2']} />;
export const IconArchive = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M21 7H3a1 1 0 00-1 1v3a1 1 0 001 1h18a1 1 0 001-1V8a1 1 0 00-1-1z',
      'M4 12v8a1 1 0 001 1h14a1 1 0 001-1v-8',
      'M10 7v0M10 12v0M10 17v0',
    ]}
  />
);
export const IconCode = (p: Props) => <Icon {...p} d={['M8 6L2 12l6 6', 'M16 6l6 6-6 6', 'M14 4l-4 16']} />;
export const IconApp = (p: Props) => <Icon {...p} d={['M5 4h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z', 'M9 9h6v6H9z']} />;
export const IconFont = (p: Props) => <Icon {...p} d={['M5 20l5-15h4l5 15', 'M7.5 15h9']} />;

export const IconUpload = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M17 18.5a4 4 0 0 0 .5-7.97 6 6 0 0 0-11.71-1.3A4.5 4.5 0 0 0 7 18.5',
      'M12 12v9',
      'M8.5 15.5L12 12l3.5 3.5',
    ]}
  />
);
export const IconDownload = (p: Props) => (
  <Icon {...p} d={['M12 4v12', 'M7 11l5 5 5-5', 'M5 20h14']} />
);
export const IconShare = (p: Props) => (
  <Icon {...p} d={['M10 13a4 4 0 005.66 0l3-3a4 4 0 10-5.66-5.66l-1.5 1.5', 'M14 11a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1.5-1.5']} />
);
export const IconLink = (p: Props) => (
  <Icon {...p} d={['M10 13a4 4 0 005.66 0l3-3a4 4 0 10-5.66-5.66l-1.5 1.5', 'M14 11a4 4 0 00-5.66 0l-3 3a4 4 0 005.66 5.66l1.5-1.5']} />
);
export const IconCopy = (p: Props) => (
  <Icon
    {...p}
    d={['M9 9h10a1 1 0 011 1v10a1 1 0 01-1 1H9a1 1 0 01-1-1V10a1 1 0 011-1z', 'M5 15H4a1 1 0 01-1-1V4a1 1 0 011-1h10a1 1 0 011 1v1']}
  />
);
export const IconTrash = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M4 7h16',
      'M10 11v6M14 11v6',
      'M6 7l1 13a2 2 0 002 2h6a2 2 0 002-2l1-13',
      'M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3',
    ]}
  />
);
export const IconEdit = (p: Props) => (
  <Icon
    {...p}
    d={['M3 21h18', 'M17 3l4 4-11 11H6v-4L17 3z']}
  />
);
export const IconMove = (p: Props) => <Icon {...p} d={['M12 3v18', 'M3 12h18', 'M7 8l-4 4 4 4', 'M17 8l4 4-4 4', 'M8 7l4-4 4 4', 'M8 17l4 4 4-4']} />;
export const IconMore = (p: Props) => <Icon {...p} d={['M5 12h.01', 'M12 12h.01', 'M19 12h.01']} />;
export const IconMoreVertical = (p: Props) => <Icon {...p} d={['M12 5h.01', 'M12 12h.01', 'M12 19h.01']} />;
export const IconLogout = (p: Props) => (
  <Icon {...p} d={['M16 17l5-5-5-5', 'M21 12H9', 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4']} />
);
export const IconSettings = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M12 15a3 3 0 100-6 3 3 0 000 6z',
      'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33h.05a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v.05a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
    ]}
  />
);
export const IconSun = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M12 17a5 5 0 100-10 5 5 0 000 10z',
      'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4',
    ]}
  />
);
export const IconMoon = (p: Props) => <Icon {...p} d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />;
export const IconGrid = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M4 4h7v7H4z',
      'M13 4h7v7h-7z',
      'M4 13h7v7H4z',
      'M13 13h7v7h-7z',
    ]}
  />
);
export const IconList = (p: Props) => (
  <Icon {...p} d={['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01']} />
);
export const IconFilter = (p: Props) => <Icon {...p} d="M4 4h16l-7 8v6l-2 2v-8L4 4z" />;
export const IconLock = (p: Props) => <Icon {...p} d={['M5 11h14v10H5z', 'M8 11V7a4 4 0 018 0v4']} />;
export const IconEye = (p: Props) => (
  <Icon {...p} d={['M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z', 'M12 15a3 3 0 100-6 3 3 0 000 6z']} />
);
export const IconEyeOff = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M9.9 5.1A10.4 10.4 0 0112 5c6.5 0 10 7 10 7a13.2 13.2 0 01-1.7 2.4',
      'M6.6 6.6A13.2 13.2 0 002 12s3.5 7 10 7a10.4 10.4 0 005.4-1.5',
      'M14.1 14.1a3 3 0 11-4.2-4.2',
      'M2 2l20 20',
    ]}
  />
);
export const IconWarning = (p: Props) => (
  <Icon {...p} d={['M12 9v4', 'M12 17h.01', 'M10.3 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z']} />
);
export const IconInfo = (p: Props) => (
  <Icon {...p} d={['M12 22a10 10 0 100-20 10 10 0 000 20z', 'M12 16v-4', 'M12 8h.01']} />
);
export const IconLogo = (p: Props) => (
  <Icon
    {...p}
    d={[
      'M6 19h12a4 4 0 000-8 5 5 0 00-9.9-1.1A3.5 3.5 0 006 19z',
    ]}
  />
);
export const IconRefresh = (p: Props) => (
  <Icon {...p} d={['M3 12a9 9 0 019-9 9 9 0 016.5 2.8L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 01-9 9 9 9 0 01-6.5-2.8L3 16', 'M3 21v-5h5']} />
);
export const IconBack = (p: Props) => <Icon {...p} d={['M19 12H5', 'M12 19l-7-7 7-7']} />;
