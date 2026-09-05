/**
 * nimSeal's own brand mark — a wax-seal shield over a private ledger. Deliberately not the Nimiq
 * logo; Nimiq brand assets are only used where the Nimiq Design Kit permits.
 */

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{ display: "inline-flex" }}
    >
      <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-full w-full">
        <rect width="40" height="40" rx="11" fill="url(#bs-g)" />
        <path
          d="M20 8.5l7.5 3v6.2c0 4.9-3.1 9.2-7.5 10.8-4.4-1.6-7.5-5.9-7.5-10.8V11.5L20 8.5z"
          fill="#fff"
          fillOpacity="0.14"
          stroke="#fff"
          strokeOpacity="0.5"
          strokeWidth="1.3"
        />
        <path
          d="M16.4 20.2l2.6 2.6 4.9-5"
          stroke="#fff"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <defs>
          <linearGradient id="bs-g" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FF6B35" />
            <stop offset="1" stopColor="#FF4D2E" />
          </linearGradient>
        </defs>
      </svg>
    </span>
  );
}
