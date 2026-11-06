"use client";

import { useState } from "react";
import { CATEGORY_ICON_NAMES, CategoryIcon } from "@/components/atoms/category-icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface CategoryIconPickerProps {
  value: string | null;
  /** Called with the chosen icon name, or null to clear back to the default. */
  onSelect: (icon: string | null) => void;
  label: string;
  disabled?: boolean;
}

export function CategoryIconPicker({ value, onSelect, label, disabled }: CategoryIconPickerProps) {
  const [open, setOpen] = useState(false);

  function choose(icon: string | null) {
    setOpen(false);
    onSelect(icon);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground"
            aria-label={label}
            disabled={disabled}
          />
        }
      >
        <CategoryIcon name={value} size={16} />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto" role="listbox" aria-label={label}>
          {CATEGORY_ICON_NAMES.map((icon) => (
            <button
              key={icon}
              type="button"
              role="option"
              aria-selected={icon === value}
              aria-label={icon.replace(/-/g, " ")}
              title={icon.replace(/-/g, " ")}
              onClick={() => choose(icon)}
              className={cn(
                "flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground",
                icon === value && "bg-primary/10 text-primary",
              )}
            >
              <CategoryIcon name={icon} size={16} />
            </button>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={() => choose(null)}>
          Use default icon
        </Button>
      </PopoverContent>
    </Popover>
  );
}
