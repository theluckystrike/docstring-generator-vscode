# Styles

| Setting `zovoDoc.style` | Looks like |
|---|---|
| `google` (default) | `Args:` / `Returns:` / `Raises:` |
| `numpy` | `Parameters` with a `----------` underline |
| `sphinx` | `:param x:` / `:type x:` / `:rtype:` |
| `epytext` | `@param x:` / `@type x:` / `@rtype:` |
| `custom` | your own Mustache template (`zovoDoc.customTemplatePath`) |

`zovoDoc.includeTypes` controls types: `always`, `hinted` (only from type hints) or `never` (the hints are enough).
