# One Judge interface, Jev as the first backend

Recipes ask Judgments through a single Noul/Choice/Score contract and never call the TypeSafe API directly. Jev, reached at TypeSafe's API or through OpenRouter's Decisions endpoint by changing the base URL, is the only backend in v1. The seam exists so an open-weights local Judge (for example a small model reading token probabilities) can be added later, notably for recipes that see sensitive state, without touching any Recipe.
