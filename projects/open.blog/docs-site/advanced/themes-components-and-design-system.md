---
title: Themes, Components, and Design System
parent: Advanced Capabilities
nav_order: 4
---

# Themes, Components, and Design System

open.blog themeing is token-driven and extensible, with support for component-level customization.

## Theme model

- Theme config is JSON-based and composable.
- Themes can inherit from other themes.
- Series-level theme assignment is supported.

## Extensibility surfaces

- Design tokens (colors, typography, spacing, etc.).
- Theme CSS overrides.
- Optional theme scripts and fonts.
- Custom web components integrated into authored content.

## Development workflow

1. Update theme assets/config under `themes/`.
2. Run local server preview.
3. Validate accessibility and contrast.
4. Build and test representative posts.

## Practical guidance

- Keep tokens consistent and semantic (avoid one-off literals).
- Prefer reusable component primitives over per-post styling hacks.
- Test across content profiles (standard, recipe, research, long-form).
