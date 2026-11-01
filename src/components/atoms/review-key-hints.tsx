export function ReviewKeyHints() {
  return (
    // Shortcuts mean nothing without a keyboard, and on a phone they just eat space.
    <div className="hidden pointer-fine:flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
      <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">Enter</kbd> Confirm</span>
      <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">→</kbd> Skip</span>
      <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">←</kbd> Back</span>
      <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">E</kbd> Category</span>
      <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">N</kbd> Notes</span>
      <span><kbd className="px-1 py-0.5 bg-muted rounded text-[10px] font-mono">Esc</kbd> Exit</span>
    </div>
  );
}
