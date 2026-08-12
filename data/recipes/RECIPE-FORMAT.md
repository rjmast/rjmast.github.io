# Adding a recipe

Every recipe is a **self-contained folder** under `recipes/data/`. Nothing is generated or built — the site reads these files directly, so it works on GitHub Pages as-is.

## The 3 steps to add a recipe

1. **Create a folder** named with the recipe's slug (lowercase, hyphens, no spaces):
   ```
   recipes/data/butter-chicken/
   ```
2. **Add two files inside it:**
   - `butter-chicken.json` — the recipe data (copy the template below).
   - `image.jpg` — a photo (optional; a colourful fallback tile shows if it's missing).
3. **Add the slug** to `recipes/data/manifest.json`:
   ```json
   ["vada-pav", "rice-pulav", "butter-chicken"]
   ```
   Order in the manifest = default order before sorting.

That's it. Commit and push. `xyz.com/recipes/` picks it up automatically, and `xyz.com/recipes/recipe.html?r=butter-chicken` is its page.

## Local preview

Because the pages `fetch` these JSON files, open them through a tiny server (not by double-clicking):

```
cd /path/to/personal_portfolio
python3 -m http.server
```
Then visit **http://localhost:8000/recipes/**.

---

## Field reference

| Field | Type | Notes |
|---|---|---|
| `slug` | string | Must match the folder name and the manifest entry. Used in the URL. |
| `title` | string | Display name. |
| `tagline` | string | One-line description (shown on the feature card + detail hero). |
| `image` | string | Filename **inside this recipe's folder** (e.g. `"image.jpg"`). Leave `""` for none. |
| `emoji` | string | Fallback icon shown when there's no image. |
| `chef` | string | "Original chef" — who the recipe came from. Filterable/searchable. |
| `cuisine` | string | Single value → drives the cuisine dropdown (e.g. `"Indian"`). |
| `course` | string | e.g. `"Snack"`, `"Main"`, `"Breakfast"`. |
| `diet` | string | `"veg"` or `"non-veg"` → drives the Veg / Non-veg filter + card dot. Egg counts as **non-veg** (Indian convention); a veg dish with an *optional* meat/egg add-on stays `"veg"`. |
| `tags` | string[] | Free tags → become filter chips + search terms. |
| `flavor` | string[] | Flavour profile → also become filter chips (e.g. `"spicy"`). |
| `ratings.overall` | number | **Your** rating out of 5 (higher = better). Sorts "Top rated". |
| `ratings.difficulty` | number | 1–5, higher = harder to make. Sorts "Easiest". |
| `ratings.availability` | number | 1–5, higher = easier to source ingredients. |
| `servings` | number | Number of servings the quantities make. |
| `servingsNote` | string | Optional clarifier (e.g. `"4 vadas, 2 pav each"`). Use `""` if none. |
| `time.prep` / `time.cook` / `time.total` | number | Minutes (numbers, so they sort/filter). |
| `macros.perServing` / `macros.whole` | object | `{ calories, protein, carbs, fat, fibre }`. Use `null` for any value you don't track (renders as "—"). |
| `macroNotes` | string[] | Prose notes under the table (calorie-cutting tips, protein boosts, etc.). |
| `ingredients` | object[] | Each `{ "group": "...", "items": ["...", "..."] }`. Repeat measurements here. |
| `steps` | object[] | Each `{ "title": "Short action", "body": "Full instruction with inline measurements." }`. |
| `notes` | string[] | Tips / caveats shown in a highlighted block. `[]` if none. |
| `source` | string | Footer line (e.g. a translation note). |

### Ratings meaning (all out of 5)

- **overall** — how good it is. Higher = better.
- **difficulty** — how hard to make. Higher = harder. (1 Very easy → 5 Hard)
- **availability** — how easy the ingredients are to source. Higher = easier. (5 Everyday → 1 Hard to find)

---

## Blank template

Copy this into `data/<slug>/<slug>.json` and fill it in:

```json
{
  "slug": "your-recipe-slug",
  "title": "Your Recipe Title",
  "tagline": "One-line description.",
  "image": "image.jpg",
  "emoji": "🍲",
  "chef": "Who it came from",
  "cuisine": "Indian",
  "course": "Main",
  "diet": "veg",
  "tags": ["tag-one", "tag-two"],
  "flavor": ["savory"],
  "ratings": { "overall": 4.5, "difficulty": 2, "availability": 4 },
  "servings": 2,
  "servingsNote": "",
  "time": { "prep": 15, "cook": 25, "total": 40 },
  "macros": {
    "perServing": { "calories": 600, "protein": 30, "carbs": 70, "fat": 18, "fibre": 8 },
    "whole":      { "calories": 1200, "protein": 60, "carbs": 140, "fat": 36, "fibre": 16 }
  },
  "macroNotes": ["Estimated from ingredients."],
  "ingredients": [
    { "group": "Group name", "items": ["1 cup something", "2 tbsp something else"] }
  ],
  "steps": [
    { "title": "First action", "body": "Do the thing with 1 cup something." }
  ],
  "notes": [],
  "source": "Translated from the original note."
}
```
