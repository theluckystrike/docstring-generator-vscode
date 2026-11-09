# JSDoc with types

Type `/*` above a function and pick *JSDoc with types*, or run *Docstring: Generate JSDoc**:

```ts
/**
 * Summary.
 *
 * @template T
 * @param {string} url - Description of url.
 * @param {number} [retries=3] - Description of retries.
 * @returns {Promise<T>} Description of the return value.
 * @throws {TypeError} Raised when ...
 */
export async function load<T>(url: string, retries = 3): Promise<T> {
```

Run the same command again after you change the signature: renamed parameters keep their text, types follow the code.
