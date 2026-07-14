import { test, expect } from "bun:test";
import {
  insert, backspace, del, left, right, home, end,
  wordLeftIndex, wordRightIndex, wordLeft, wordRight, deleteWordBack, deleteWordForward,
} from "./text-buffer";

const b = (value: string, cursor = value.length) => ({ value, cursor });

test("insert writes at the cursor and advances it", () => {
  expect(insert(b("ac", 1), "b")).toEqual({ value: "abc", cursor: 2 });
  expect(insert(b("", 0), "hi")).toEqual({ value: "hi", cursor: 2 });
});

test("backspace/del/left/right/home/end at the cursor", () => {
  expect(backspace(b("abc", 2))).toEqual({ value: "ac", cursor: 1 });
  expect(backspace(b("abc", 0))).toEqual({ value: "abc", cursor: 0 }); // no-op at start
  expect(del(b("abc", 1))).toEqual({ value: "ac", cursor: 1 });
  expect(del(b("abc", 3))).toEqual({ value: "abc", cursor: 3 });        // no-op at end
  expect(left(b("abc", 2)).cursor).toBe(1);
  expect(left(b("abc", 0)).cursor).toBe(0);
  expect(right(b("abc", 2)).cursor).toBe(3);
  expect(right(b("abc", 3)).cursor).toBe(3);
  expect(home(b("abc", 2)).cursor).toBe(0);
  expect(end(b("abc", 1)).cursor).toBe(3);
});

test("wordLeftIndex: skips trailing spaces, then the run of same-class chars", () => {
  expect(wordLeftIndex("the quick fox", 13)).toBe(10); // -> start of "fox"
  expect(wordLeftIndex("the quick fox", 10)).toBe(4);  // from "fox" start -> start of "quick"
  expect(wordLeftIndex("the quick   fox", 12)).toBe(4); // multiple spaces collapse
  expect(wordLeftIndex("foo.bar", 7)).toBe(4);          // stops at the punctuation boundary
  expect(wordLeftIndex("foo.bar", 4)).toBe(3);          // the "." is its own unit
  expect(wordLeftIndex("hello", 0)).toBe(0);            // at start
  expect(wordLeftIndex("héllo wörld", 11)).toBe(6);     // unicode letters are word chars
});

test("wordRightIndex: skips leading spaces, then the run of same-class chars", () => {
  expect(wordRightIndex("the quick fox", 0)).toBe(3);   // end of "the"
  expect(wordRightIndex("the quick fox", 3)).toBe(9);   // -> end of "quick"
  expect(wordRightIndex("foo.bar", 0)).toBe(3);         // stops before "."
  expect(wordRightIndex("foo.bar", 3)).toBe(4);         // the "." unit
  expect(wordRightIndex("abc", 3)).toBe(3);             // at end
});

test("wordLeft/Right move the cursor; delete-word removes the spanned range", () => {
  expect(wordLeft(b("the quick fox", 13))).toEqual({ value: "the quick fox", cursor: 10 });
  expect(wordRight(b("the quick fox", 0))).toEqual({ value: "the quick fox", cursor: 3 });
  expect(deleteWordBack(b("the quick fox", 13))).toEqual({ value: "the quick ", cursor: 10 });
  expect(deleteWordBack(b("hello ", 6))).toEqual({ value: "", cursor: 0 }); // trailing space + word
  expect(deleteWordForward(b("the quick fox", 3))).toEqual({ value: "the fox", cursor: 3 });
});
