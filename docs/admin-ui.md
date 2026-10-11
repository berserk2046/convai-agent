# Changing how the admin looks

The admin's look is set in a few files. Screens are built from shared pieces, so most
changes are made once and every screen follows.

## Where to change what

| To change…                                                                       | Edit                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Colors, corner radius, font                                                      | the `@theme` tokens in `apps/admin/src/app/globals.css`                                           |
| Page background                                                                  | `body` in `globals.css`                                                                           |
| Buttons, fields, cards, badges, alerts, tables, page titles                      | `apps/admin/src/components/ui.tsx` (one recipe per piece)                                         |
| Header, navigation, page width (`max-w-6xl`)                                     | `apps/admin/src/components/shell.tsx` and `nav-link.tsx`                                          |
| The generated setup form (`/setup`)                                              | the `.rjsf` rules in `globals.css`                                                                |
| Message bubbles in a conversation (inbox, eval reports, playground)              | the `--color-message-*` tokens; the shape is `ChatBubble` in `apps/admin/src/components/chat.tsx` |
| The bookings calendar: scale (pixels per minute), booking chip colors per status | `PX_PER_MINUTE` and `STATUS_STYLE` in `app/(business)/bookings/calendar.tsx`                      |
| The template diff on `/templates`                                                | `apps/admin/src/components/diff-view.tsx`                                                         |

### Tokens

Each token in `@theme` becomes Tailwind utilities: `--color-primary` gives `bg-primary`,
`text-primary`, `border-primary`, and so on. The main ones:

- **`--color-primary`** is the brand color: main buttons and the unread badge.
- **`--color-muted`** and **`--color-muted-foreground`** are quiet fills and secondary text.
- **`--color-success`**, **`--color-warning`** and **`--color-destructive`** are statuses,
  shared by alerts, badges, booking chips and the diff.
- **`--color-message-in`** and **`--color-message-out`** are inbox bubbles: from the
  customer, and from the business.
- **`--font-sans`** is the font. For a web font, load it in `apps/admin/src/app/layout.tsx`
  and put its name first here.

Colors are written in `oklch(lightness chroma hue)`. Lightness runs from 0 to 1, chroma is
the colorfulness (0 is gray), and hue is an angle (190 is teal, 155 green, 27 red).

## Rules that keep it easy

- Screens use token names (`bg-primary`, `text-muted-foreground`), never raw palette colors
  such as `bg-red-500`. Then a new palette is a change to `globals.css` only.
- Anything used on two screens becomes a piece in `ui.tsx`, not a copied class list.
- Components are plain HTML elements styled in the shadcn/ui manner (ADR 0011). There is no
  component library to fight.

## Words

- Business screens are in Colombian Spanish, and owner screens are in English. The words
  live in each screen's file.
- What customers read on WhatsApp comes from the templates, not from the admin.
- The smoke test (`apps/admin/e2e/smoke.spec.ts`) finds elements by their visible text and
  labels, never by style. A restyle doesn't break it; changing the words of a button or a
  heading means updating the test.

## Seeing changes

`pnpm dev:admin` reloads the page as you save.

To review screens filled with data, run `pnpm test:e2e` once. It leaves the `e2e_admin`
database with the dental business from the test: two chairs, a booking and a conversation.
Then point the admin at it, using your `DATABASE_URL` with the database name changed:

```sh
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/e2e_admin pnpm dev:admin
```

Log in as `ana@sonrisas.test` (password `clave-temporal-e2e`) to see the business screens,
or as `owner@e2e.test` (password in `apps/admin/e2e/env.ts`) to see the owner screens. The
next `pnpm test:e2e` run recreates this database.
