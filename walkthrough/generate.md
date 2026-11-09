# Type """ and press Enter

```python
def buy(item: str | None, /, qty: int = 1, *, force: bool = False) -> list[int]:
    """
```

Press Enter on the suggestion "Generate Docstring" and you get:

```python
def buy(item: str | None, /, qty: int = 1, *, force: bool = False) -> list[int]:
    """Summary.

    Args:
        item (str | None): Description of item.
        qty (int, optional): Description of qty. Defaults to 1.
        force (bool, optional): Description of force. Defaults to False.

    Returns:
        list[int]: Description of the return value.
    """
```

Tab jumps from one placeholder to the next. The command *Docstring: Generate Docstring* (Cmd+Shift+2 or Ctrl+Shift+2) does the same with the cursor anywhere in the function.
