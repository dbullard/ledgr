import { CategoryIcon } from "@/components/atoms/category-icon";
import { categoryToneStyle } from "@/lib/category-tone";
import { categoryLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";

interface CategoryChipProps {
  name: string | null;
  icon?: string | null;
  className?: string;
}

/** Read-only coloured category tag, as shown on dashboard rows. */
export function CategoryChip({ name, icon, className }: CategoryChipProps) {
  return (
    <span
      style={categoryToneStyle(name)}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        className,
      )}
    >
      {icon !== undefined && <CategoryIcon name={icon} size={11} className="shrink-0" />}
      <span className="truncate">{categoryLabel(name)}</span>
    </span>
  );
}
