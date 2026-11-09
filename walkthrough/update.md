# Update after the signature changed

You renamed `a` to `alpha` and added `beta`:

```python
def start(alpha: int, beta: str = "x") -> int:
    """Start the engine.

    Args:
        a (int): The first value, written by hand.
    """
```

Run *Docstring: Update Docstring*:

```python
    Args:
        alpha (int): The first value, written by hand.
        beta (str, optional): Description of beta. Defaults to "x".

    Returns:
        int: Description of the return value.
```

Your text stays. A removed parameter that still has your text is kept and marked `[removed from the signature]`, so you can move the text or delete it. *Update All Docstrings in File* does every function at once, and `zovoDoc.updateOnSave` does it when you save.
