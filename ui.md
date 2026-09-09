# YardSale Cloud — Saturday morning on the front lawn

## Brief and scope

Redesign the SaaS app in `yardsale-cloud/`, served at localhost:3010. The physical reference is a neighborhood yard sale: a reused packing-box sign written with a fat marker, a sun-faded green board, masking tape, paper price tags, a handwritten list beside the cash tin. It should feel friendly, resourceful, and slightly weathered. This is art direction for an actual working app, not a static concept.

Primary implementation: `yardsale-cloud/src/html.js` and `yardsale-cloud/public/styles.css`; small locally served assets and a narrow static-asset route in `src/server.js` are allowed. Preserve current uncommitted work. Do not redesign the separate root storefront app or change billing, authentication, policy, runtime, or database behavior. No framework or UI library migration.

## Design thesis

The landing page is a handmade invitation; the signed-in app is the notebook used to run the sale. Do not merely recolor the existing generic SaaS hero and rounded cards. Create one memorable composed sign and carry a restrained material vocabulary through every screen. Imperfection has a reason: tape holds a note, a hole belongs on a price tag, wear follows an exposed edge. Keep controls straight and readable.

## Visual system

| Role | Direction |
| --- | --- |
| Ground | Warm oatmeal paper `#f2e9d8`, quiet fine grain, no glowing radial gradient |
| Ink | Deep warm charcoal `#302a22`; secondary copy `#655847` |
| Cardboard | Kraft `#c69e69`, darker exposed edge `#987347`; subtle corrugation at torn edge only |
| Paint | Faded garden green `#496352`, with light chips at a few edges; off-white lettering |
| Accent | Brick red `#a34532` for marker arrows and small emphasis; butter paper `#eee0a9` for notes |
| Paper | Cream `#fff9ed`; small hard/soft layered shadow suggesting a sheet resting on a table |

Use a real locally hosted marker face (Permanent Marker, distributed under Apache 2.0 in Google Fonts) for the wordmark, short display headings, and price numerals. Include its license. Use a separate legible handwritten face only if it adds enough value; two font families total are sufficient with a readable system body face. Body copy, form labels, dates, errors, admin controls, and legal text remain conventional 16px minimum where practical. No dependency on a font installed on this computer or third-party font requests at runtime. Normal tracking and comfortable 1.5 line-height for body; marker headings around 1.05–1.15. Avoid squeezed negative tracking.

At most three material treatments: kraft, cream paper, painted wood. Build them in CSS or small original SVG assets; restrained grain must not cross text at visible opacity. No generated stock hero collage is needed. Decorative shapes are aria-hidden, noninteractive, and pointer-events:none. Restrict rotation to a sign/note/price sticker (roughly -2 to +2 degrees); no randomized rotations or transforms on whole forms. No floating animations, glass, luminous gradients, giant rounded panels, pill navigation, emoji decoration, or identical triplets of feature cards.

## Shared shell

Compact header on warm paper, with a marker YardSale wordmark and a small secondary Cloud annotation. Use a distinctive hand-drawn directional arrow or simple sign silhouette rather than a rounded app-icon initial. Keep the brand a working home/dashboard link. Public navigation: Browse sales, Sign in, and a small painted rectangular Create a store button. Signed-in navigation retains Dashboard, Admin where permitted, Sign out, and can include Browse sales. Wrap gracefully on phones; no JS menu is necessary. Add a keyboard-visible skip-to-content link and clear focus-visible outlines.

Footer is understated: short neighborly brand line plus every existing legal/abuse link. Functional pages should not require scrolling through decorative marketing sections.

## Landing page composition

Desktop at 1280px: max content width about 1120px, 32–56px top spacing rather than the current tall blank intro. Left roughly 55% is a substantial imperfect kraft sign, written in real HTML marker type: small “YARD SALE, ONLINE”, headline “Good stuff. / New homes.” A bold loose red arrow points toward the primary action below the sign. A shallow fold, a little tape at the top, and an irregular edge give it a physical presence. The sign must be legible and visually dominant, not a tiny card next to an enormous corporate headline.

Right roughly 40% is a quieter cream pinned invitation, with human copy: “The spare chair. The outgrown bike. The box of books by the door.” Then explain the product concretely: “Put them in your own little online store. Share the link and arrange a pickup.” Primary CTA “Set up my sale” routes to signup; secondary “Have a look around” routes to marketplace. An overlapping small price tag can show the dynamic free period. Give the two areas different heights and useful breathing room; avoid a symmetrical feature-grid feel.

Below: a modest chipped green plank carrying the practical pricing promise in light type. Render amounts and durations from the existing `policy` values; default is 14 days free and $5.00 per 30-day extension, but NEVER hardcode these terms. Explain that paid time keeps the same store and listings; one active free store remains visible. Do not imply buyer payments are processed or that free stores automatically appear in the marketplace. Put a short “You arrange pickup and payment with the buyer” sentence nearby. Do not advertise production HTTPS/provisioning promises beyond the prototype's actual behavior.

Then a short “From the spare room to someone else's” how-to as an editorial row/list (name your sale; add your things; share your link), with simple marker numbers or handwritten ticks. Avoid three identical bordered cards. An optional small margin annotation (“a little room to breathe”) should feel intentional, not repeated on every section. No fabricated customer quotes, reviews, scarcity, inventory, or testimonials.

## Screen-specific application

- Signup/login: a cream form sheet with one restrained tape corner, next to a small welcoming sign. Keep all inputs, constraints, values, hidden fields and redirects intact. Remove the pseudo-quote about continuity. Signup copy should explain creating an account and naming a store, without claiming it already exists. Login can say “Back for another look?” Form titles/buttons remain unambiguous.
- Dashboard: “Your sales” as a marker heading; display email as ordinary small text rather than embedding a long email in a giant heading. Metrics become a simple ledger strip with separators. Store cards are cream inventory sheets; small statuses have text and color. Empty state is a quiet unused label: “A spot for your first sale”, with Create a store. Do not seed fake stores.
- Create store: a labeled paper form with an adjoining checklist. Rewrite runtime/provisioning jargon into accurate user-facing steps (choose a name, reserve an address, manage your store). Preserve slug constraints, coupon, CSRF and policy-derived terms. Address preview uses a readable monospace line and wraps.
- Store detail: same paper/ledger language. Keep every operational section, effective policy, checkout, marketplace opt-in, promotion, lifecycle and delete control. Destructive actions are explicit with red treatment, away from routine controls. Dense data and forms remain upright.
- Marketplace: “Have a look around” heading, a search sheet with clearly labeled native filter controls. Listing photos remain central, with actual prices on small paper-tag accents. No fake merchandise or decorative SOLD stamps. Actual empty state explains there are no matches and suggests broadening filters. Use 3/2/1 listing columns as width allows.
- Billing/checkout: receipt-like sheet with a subtle perforated rule, readable amounts and payment statuses. Mock payment labels stay unmistakably mock. Preserve all provider fields/actions and references.
- Admin: maintain every existing management capability with modest paper panels and strong headings; no rotations, giant marker labels on inputs, or whimsical names replacing operational terms. Dense forms should wrap without overflow; add visible or accessible names to currently placeholder-only fields where touched.
- Verification, error, reports and legal pages: inherited paper shell, clear headings, legible plain-language body. Preserve error details and legal content; errors need role=alert, notices role=status.

## Interaction and accessibility requirements

Preserve semantic headings, native buttons/links, all form actions/methods/name fields, CSRF values and escaped user content. No UI-only dead links. All user-facing controls have accessible names. Search filters need labels, not only placeholder text. Use 44px target heights for primary controls, strong visible keyboard focus, underlined inline links, and contrast of at least 4.5:1 for ordinary text. Decorative texture must not reduce legibility. Focus outlines must not be clipped by torn-edge effects; apply clipping only to decorative layers.

At 390px and 320px: stack the hero, keep its sign within page gutters, show the primary action without excessive scrolling, wrap navigation and long domains/emails, collapse all grids sensibly, and keep the full document free of horizontal overflow. Respect reduced motion (no essential motion). Use local assets under existing CSP; add only a narrow allowlisted GET asset mapping for font files with correct MIME if necessary. Version the stylesheet URL to avoid the existing one-hour cache hiding the redesign. Do not weaken CSP.

## Implementation order and acceptance

1. Replace the stylesheet's design system and shared shell; acquire the actual licensed marker font and serve it locally.
2. Recompose landing HTML as above; keep all commercial values dynamic.
3. Adapt auth/dashboard/new-store/marketplace copy and structures, then ensure remaining screens inherit a coherent restrained system.
4. Run `npm run check` and `npm test` in `yardsale-cloud`; inspect any failure before changing assertions. Verify root/store behavior has not been changed.
5. Review live desktop and mobile screenshots, including homepage, signup/login, marketplace empty state, and representative dashboard/store/billing/admin screens using isolated test data if necessary. Check actual navigation and a form validation state. Never modify the user's existing accounts to get screenshots.
6. Report changed files, tests, and any limits to the parent reviewer. Parent must inspect screenshots itself and request another pass if the page is still generic or the rustic effect is costume-like.

## Art-director review gate

Ask: “Is it obvious that this was designed by AI? Does it feel cozy and human?” This is a subjective visual check, not a detector claim. Reject if removing the beige color reveals the exact original SaaS composition; if every component has identical tape, tilt and rounded corners; if the marker font did not load; if copy sounds like a hosting pitch; or if charming decoration makes forms harder to use. Accept when the page has a memorable handmade focal point, deliberate asymmetry, comfortable readable surfaces, ordinary human copy, honest data, and care on phones as well as desktop. Document concrete findings and any second pass below after implementation.

## Review record

Implemented by Luna at Max and reviewed live on 2026-09-09.

First pass: the visual identity was distinctive and warm, with a real locally served marker face, a dominant kraft sign, a quieter paper invitation, and restrained paper/paint treatments on working screens. It did not read as the original generic SaaS layout with beige colors. The review rejected two usability details: at 1264×720 the primary CTA began below the viewport at y=816, and the price tag overlapped the invitation fine print. The marketplace filter form also lacked its intended desktop grid and became an overly long single-column stack.

Second pass: the desktop sign was capped at 500px; the CTA now occupies y=636–684 at 1264×720. The price tag moved into normal document flow below the invitation actions, with no intersection. Marketplace filters use three columns on desktop and one at 390px. At 390×844 the homepage CTA ends at y=659, the document width equals the viewport width (390px), the local Permanent Marker face is loaded, and the marketplace form also has no horizontal overflow. Login, seller dashboard, populated marketplace, and public landing views were visually inspected. The final judgment is that the interface feels cozy, specific, and handmade without turning forms and operational screens into props.

Validation: `npm run check` and all 12 tests pass in `yardsale-cloud`.
