# Changelog

## 0.1.0

- First release: Python docstrings in Google, NumPy, Sphinx (reST) and Epytext style or from a custom Mustache template. Type `"""` and press Enter under a def or class, or use the command or the light bulb.
- Reads the signature with tree-sitter (bundled, no Python needed): type hints, defaults, `*args`, `**kwargs`, positional-only `/` and keyword-only `*` parameters, return type, `yield`, `raise` (nested functions ignored), dataclass fields, `__init__` arguments and attributes.
- Update Docstring after the signature changed: renamed parameters keep their text, new ones get a placeholder, removed ones are marked. Also for a whole file, and on save if you turn it on.
- JSDoc for JavaScript and TypeScript with `@param` types, optional and default values, `@returns`, `@throws`, `@yields` and `@template`, and the same update.
- Defaults and types copied from the code are escaped: triple quotes and backslashes in a docstring, `*/` in a JSDoc block. A default such as `sep='"""'`, `r'\d+'` or `'**/*.ts'` no longer ends the docstring or comment early.
- Free, no sign-in, works offline. Rating ask, support links and related tools.
