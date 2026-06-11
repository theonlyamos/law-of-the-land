## Design Context

### Users
Law of the Land serves a **mixed audience**:
- **General public**: Everyday people (tenants, consumers, employees) seeking to understand their legal rights in plain language
- **Legal professionals**: Lawyers, paralegals, and legal researchers needing quick reference and document search
- **Business owners**: Entrepreneurs and managers checking compliance and regulations

Users are often in a **research context** — they need clear, reliable answers about laws that affect their lives or work. Some may be stressed (legal issues are inherently anxiety-inducing), others may be proactive (business compliance checks).

### Brand Personality
**Professional, Authoritative, Precise**

- **Professional**: Clean, polished interface that commands respect (inspired by Stripe & Linear)
- **Authoritative**: Users should trust the legal information provided; the interface conveys reliability
- **Precise**: Accurate, exact legal information presented without unnecessary fluff

**Emotional goals**: Evoke **confidence & trust**, **calm & reassurance**, and make users feel **empowered & clear** about their legal standing.

### Aesthetic Direction
**Visual tone**: Minimal, polished, great UX with attention to detail (Stripe/Linear inspired)

**Key characteristics**:
- Clean typography with Geist Sans/Mono font stack
- HSL-based color system with CSS variables (supports light/dark modes)
- Whitespace-rich layouts that don't overwhelm
- Precise spacing and alignment (Tailwind CSS 4 with Tailwind-scrollbar-hide)

**References** (positive):
- **Stripe**: Minimal, polished, great UX with attention to detail
- **Linear**: Modern, clean, great typography and whitespace

**Anti-references** (explicitly avoid):
- ❌ Cluttered legal databases (tiny text, complex navigation)
- ❌ Gamified apps (too playful, cartoonish for serious legal matters)
- ❌ Generic AI chatbots (plain ChatGPT-style without legal-specific design)
- ❌ Corporate enterprise (overly stiff, traditional law firm aesthetic with serif fonts)

**Theme**: Both light and dark modes supported (system preference with manual toggle)

### Design Principles
1. **Clarity First** — Legal information must be crystal clear; no ambiguity in UI text or layout. Every word should help users understand their rights.

2. **Professional Precision** — Clean, minimal design with precise typography. Inspired by Stripe/Linear: generous whitespace, exact spacing, polished components (Radix UI + Tailwind CSS 4).

3. **Build Trust** — Authoritative presentation that makes users confident in the legal information. Use reliable patterns, clear error messages, and consistent terminology.

4. **Empower Through Access** — Make complex legal concepts accessible without dumbing down. Use clear language, helpful empty states, and progressive disclosure.

5. **Calm Confidence** — Reduce anxiety around legal matters through reassuring, calm interface. Avoid alarmist language; use supportive error messages and clear next steps.

### Technical Context
- **Framework**: Next.js 16 (App Router), React 19, TypeScript
- **Styling**: Tailwind CSS 4 (CSS-first config with `@theme`), Radix UI components
- **Fonts**: Geist Sans, Geist Mono (local fonts)
- **AI Integration**: Gemini 3.1 Flash Lite (primary), OpenAI, GroundX for RAG
- **Real-time**: Socket.io for bidirectional communication

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
