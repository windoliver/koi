/**
 * File icon component — maps file extensions/names to lucide icons.
 */

import {
  File,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Settings,
  Database,
  Activity,
  type LucideIcon,
} from "lucide-react";

const EXTENSION_ICONS: Readonly<Record<string, LucideIcon>> = {
  ".json": FileJson,
  ".jsonl": FileJson,
  ".yaml": Settings,
  ".yml": Settings,
  ".toml": Settings,
  ".md": FileText,
  ".txt": FileText,
  ".log": FileText,
  ".db": Database,
  ".sqlite": Database,
};

const NAME_ICONS: Readonly<Record<string, LucideIcon>> = {
  "manifest.json": Settings,
  "events": Activity,
};

function getFileIcon(name: string, isDirectory: boolean, isOpen: boolean): LucideIcon {
  if (isDirectory) {
    return isOpen ? FolderOpen : Folder;
  }

  const nameLower = name.toLowerCase();
  const nameIcon = NAME_ICONS[nameLower];
  if (nameIcon !== undefined) return nameIcon;

  const dotIndex = nameLower.lastIndexOf(".");
  if (dotIndex >= 0) {
    const ext = nameLower.slice(dotIndex);
    const extIcon = EXTENSION_ICONS[ext];
    if (extIcon !== undefined) return extIcon;
  }

  return File;
}

export function FileIcon({
  name,
  isDirectory,
  isOpen,
  className,
}: {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly isOpen?: boolean;
  readonly className?: string;
}): React.ReactElement {
  const Icon = getFileIcon(name, isDirectory, isOpen ?? false);
  return <Icon className={className ?? "h-4 w-4 shrink-0"} />;
}
