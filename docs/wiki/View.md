# View

`openarc view` shows the `.arc` spec in a terminal and, per function, whether the code meets it: the [[Arc Sync]] status, live. Keep it open in a second terminal next to a coding agent, or use it alone with `c` to compile through the configured model.

```
openarc view [<module>] [--out=<dir>]
openarc view --once [<module>] [--width <n>] [--out=<dir>]
```

```
ok 1  stale 1  unrunnable 0  no examples 1
  - calc                       stale│   calc.triple  stale  arc/spec/calc.arc:8
    double                        ok│   fn triple(n: Num): Num
>   triple                     stale│     "Triples a number."
    hello                no examples│ !   example (3) => 9
                                    │     example (3) => 9: the code returns 6
                                    │     example (0) => 0
                                    │     observed (3) => 6

/ filter  r check  R check all  c compile  e edit  ? keys  q quit
```

The top line counts the functions per status. On the left are the modules and their functions, each with its status in words: `ok`, `stale`, `unrunnable`, `no examples`, `checking` while a check runs, or `unchecked`. A module shows its worst status. On the right is the selected function's text exactly as it is in the `.arc` file. A failing `example` or a broken `rule` is marked `!` and followed by what the code did, in the words `openarc arc status` uses. Below 80 columns the spec goes under the list. Colour is added on a terminal and left out when `NO_COLOR` is set. The words are always there.

## Keys

| Key | |
|---|---|
| up/down, `j`/`k` | move |
| `enter` | open or close a module |
| `right` / `left` | open a module / go back to the module, or close it |
| `r` | check the selected function (or module) again |
| `R` | check everything again |
| `c` | compile the selected stale function: runs `openarc arc compile <module.fn>` as a child process and shows its output above the key line |
| `e` | open the `.arc` file at the function's line in `$EDITOR` (`$EDITOR +<line> <file>`) |
| `/` | filter by name: `enter` keeps the filter, `esc` clears it |
| `?` | the keys |
| `q`, ctrl-c | quit |

Checks run in the background as `openarc arc status <target> --json`, one at a time, so the screen never waits for them. When a `.arc` file or a module's source file changes, that module is checked again (debounced by 300 ms). Quitting restores the terminal (normal screen, cursor, line mode), and so does a crash or `SIGTERM`/`SIGHUP`/`SIGINT`.

## `--once`

`--once` prints one frame and exits: every function with its status, and the first stale function's spec (or the first function's). The exit code is 1 when any function is stale, else 0. The same happens when stdout or stdin is not a terminal. `--width` sets the width (default: the terminal's, else 100).

## Limits

- A module is checked again when its own source file changes, not when a file it imports does.
- A source directory created after the view starts is not watched.
- Long lines in the spec wrap. A function longer than the pane is cut at the bottom (there is no scrolling).
- `e` runs `$EDITOR` through `sh`, so it works on POSIX systems only.
