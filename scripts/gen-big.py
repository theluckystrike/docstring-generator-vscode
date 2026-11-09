#!/usr/bin/env python3 -I
"""Write big_10k.py: a ~10,500-line Python module. Targets: middle_target (about line 5,000) and end_target (near the end)."""
import sys

out = sys.argv[1] if len(sys.argv) > 1 else 'big_10k.py'
L = ['"""Generated module for the large-file test (10,000+ lines)."""', 'from typing import Optional', '', '']

def func(i):
    return [f'def func_{i}(a: int, b: str = "x{i}", *rest: float, flag: bool = False) -> Optional[int]:',
            f'    """Already documented function {i}."""',
            f'    if a < 0:', f'        raise ValueError("a")', f'    total = a + {i}', f'    for r in rest:',
            f'        total += int(r)', f'    return total if flag else None', '', '']

def cls(i):
    return [f'class Model{i}:', f'    def __init__(self, name: str, size: int = {i}):', '        self.name = name', '        self.size = size', '',
            f'    def grow(self, by: int) -> int:', '        self.size += by', '        return self.size', '', '']

i = 0
while len(L) < 5000:
    L += func(i) if i % 3 else cls(i); i += 1
L += ['def middle_target(path: str, retries: int = 3, *, verbose: bool = False) -> list[str]:', '',
      '    if retries < 0:', '        raise ValueError("retries")', '    return [path] * retries', '', '']
while len(L) < 10400:
    L += func(i) if i % 3 else cls(i); i += 1
L += ['def end_target(items: list[dict[str, int]], key: str, /, default: int | None = None, **opts) -> dict[str, int]:', '',
      '    if not items:', '        raise LookupError(key)', '    return {key: default or 0}', '']
open(out, 'w').write('\n'.join(L) + '\n')
print(out, len(L), 'lines')
