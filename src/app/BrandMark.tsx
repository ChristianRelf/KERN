export function BrandMark({ className, size = 20 }: { className?: string; size?: number }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 1024 1024" aria-hidden>
      <rect x="64" y="64" width="896" height="896" rx="200" fill="var(--surface-3)" stroke="var(--border-strong)" strokeWidth="24" />
      <path d="M470 500 L676 742" stroke="var(--text-3)" strokeWidth="88" strokeLinecap="round" fill="none" />
      <path d="M446 540 L664 286" stroke="var(--text)" strokeWidth="88" strokeLinecap="round" fill="none" />
      <rect x="318" y="242" width="88" height="540" rx="44" fill="var(--text)" />
    </svg>
  );
}
