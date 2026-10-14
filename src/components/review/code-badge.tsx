import { cn } from "@/lib/utils";

export function CodeBadge({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-block max-w-full break-all rounded-md border border-black/40 bg-white px-1.5 py-0.5 font-mono text-[11px] font-semibold leading-4 text-black/80",
        className,
      )}
    >
      {code}
    </span>
  );
}
