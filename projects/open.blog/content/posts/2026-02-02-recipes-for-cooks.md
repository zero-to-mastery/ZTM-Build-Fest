---
title: "Recipes, too: lemon garlic pasta"
date: 2026-02-02
tags:
  - recipe
  - guide
description: open.blog is not only for code. Mark a post as a recipe and readers get a recipe card, servings scaling, checklists, timers, cook mode, and a print view.
profile: recipe
servings: 4
prep: 10 min
cook: 15 min
cuisine: Italian
course: Dinner
---

open.blog is not only for code. Add `profile: recipe` to a post's front matter, put the
ingredients in a list under an `## Ingredients` heading and the steps in a list under a
`## Steps` heading, and the post becomes a recipe:

- A summary card with the times and servings, and a "Jump to recipe" link.
- Buttons that scale the amount at the start of each ingredient to more or fewer servings.
- Checkboxes to tick off ingredients and steps (remembered on the reader's device).
- Timers: any time in a step, like "10 minutes", starts a countdown when tapped.
- Cook mode keeps the screen awake, and "Print recipe" prints just the recipe.
- Search engines get schema.org recipe data; with a photo, the post can appear as a recipe result.

Start a new one with `openblog new "Lemon garlic pasta" --recipe`. This post is a working
example; try the buttons above.

> [!TIP]
> Save a cup of the pasta water before you drain it. Its starch makes the sauce glossy.

## Ingredients

- 400 g spaghetti
- 3 tbsp olive oil
- 4 cloves garlic, thinly sliced
- 1 1/2 lemons, zested and juiced
- 1/2 cup grated parmesan, plus more to serve
- 1 handful parsley, chopped
- Salt and black pepper, to taste

## Steps

1. Bring a large pot of salted water to the boil and cook the spaghetti for 9 minutes.
2. Meanwhile, warm the olive oil in a wide pan over low heat and cook the garlic for
   2-3 minutes, until soft but not brown.
3. Save a cup of the pasta water, then drain the spaghetti and add it to the pan.
4. Add the lemon zest and juice, the parmesan, and a splash of pasta water. Toss for
   1 minute, until glossy, adding more water if it looks dry.
5. Season, scatter over the parsley, and serve with more parmesan.

## Notes

The front matter for this post:

```yaml
profile: recipe
servings: 4
prep: 10 min
cook: 15 min
cuisine: Italian
course: Dinner
```

Times can be written as `15 min`, `1 hr 30 min`, or `1:30`; something like `overnight`
is shown as written. Use `makes: 12 cookies` to say what a recipe makes, alongside
`servings` if readers should be able to scale it.
