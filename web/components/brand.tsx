/**
 * nimSeal's brand mark — a document that terminates in a shield point, with a keyhole over the
 * private terms and a chevron for settlement. Deliberately not the Nimiq logo; Nimiq brand assets
 * are only used where the Nimiq Design Kit permits.
 *
 * viewBox is portrait (72×104); the default `xMidYMid meet` keeps it undistorted inside any box.
 */

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={className} aria-hidden="true" style={{ display: "inline-flex" }}>
      <svg
        viewBox="0 0 72 104"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="h-full w-full"
      >
        <defs>
          <clipPath id="nsBody">
            <path d="M 43 3 L 69 27 V 59 L 36 99 L 3 59 V 9 A 6 6 0 0 1 9 3 Z" />
          </clipPath>
        </defs>

        {/* Shield / document body. */}
        <path fill="#7F4CF6" d="M 43 3 L 69 27 V 59 L 36 99 L 3 59 V 9 A 6 6 0 0 1 9 3 Z" />

        {/* Folded page corner. */}
        <path fill="#FFFFFF" d="M 43 3 L 69 27 L 48 27 A 5 5 0 0 1 43 22 Z" />

        {/* Chevron band, clipped so it can never spill past the shield edge. */}
        <g clipPath="url(#nsBody)">
          <polyline
            points="-4,46 36,86 76,46"
            fill="none"
            stroke="#FFFFFF"
            strokeWidth="9"
            strokeLinejoin="round"
          />
        </g>

        {/* Keyhole: the sealed terms. */}
        <circle cx="36" cy="36" r="9" fill="#FFFFFF" />
        <path fill="#FFFFFF" d="M 32.2 43 L 39.8 43 L 42 58 L 30 58 Z" />
      </svg>
    </span>
  );
}
