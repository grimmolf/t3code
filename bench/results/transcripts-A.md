Task A, tags main,r2. Counts are samples.

| model | arm | n | sed/perl | node heredoc | code_run (of which shell sed/perl) | Edit tool | other script | folded search | retried | retry reasons |
|---|---|---|---|---|---|---|---|---|---|---|
| haiku-5-5 | off | 5 | 5 | 0 | 0 (0) | 0 | 0 | 0 | 3 | 3× BSD sed treats \b as a literal, so the first edit matched nothing |
| haiku-5-5 | instructions | 5 | 1 | 4 | 0 (0) | 0 | 0 | 0 | 1 | 1× BSD sed treats \b as a literal, so the first edit matched nothing |
| haiku-5-5 | tool | 5 | 3 | 0 | 3 (0) | 0 | 0 | 0 | 2 | 1× BSD sed treats \b as a literal, so the first edit matched nothing; 1× zsh did not split an unquoted $files |
| sonnet-5-5 | off | 10 | 10 | 0 | 0 (0) | 0 | 0 | 0 | 2 | 2× BSD sed treats \b as a literal, so the first edit matched nothing |
| sonnet-5-5 | instructions | 10 | 10 | 0 | 0 (0) | 0 | 0 | 0 | 4 | 4× BSD sed treats \b as a literal, so the first edit matched nothing |
| sonnet-5-5 | tool | 10 | 0 | 0 | 10 (3) | 0 | 0 | 8 | 0 | - |
| sonnet-5-5 | bashchain | 10 | 10 | 0 | 0 (0) | 0 | 0 | 5 | 0 | - |
| opus-5-5 | off | 8 | 8 | 0 | 0 (0) | 0 | 0 | 0 | 5 | 2× zsh did not split an unquoted $files; 2× both: BSD sed \b and an unsplit zsh $files; 1× BSD sed treats \b as a literal, so the first edit matched nothing |
| opus-5-5 | instructions | 8 | 8 | 1 | 0 (0) | 0 | 0 | 0 | 4 | 2× BSD sed treats \b as a literal, so the first edit matched nothing; 1× both: BSD sed \b and an unsplit zsh $files; 1× zsh did not split an unquoted $files |
| opus-5-5 | tool | 8 | 0 | 0 | 8 (0) | 0 | 0 | 1 | 0 | - |
| opus-5-5 | bashchain | 8 | 8 | 0 | 0 (0) | 0 | 0 | 0 | 0 | - |
Task C, tags r2. Counts are samples.

| model | arm | n | sed/perl | node heredoc | code_run (of which shell sed/perl) | Edit tool | other script | folded search | retried | retry reasons |
|---|---|---|---|---|---|---|---|---|---|---|
| opus-5-5 | off | 3 | 3 | 0 | 0 (0) | 0 | 0 | 0 | 0 | - |
| opus-5-5 | tool | 3 | 3 | 0 | 0 (0) | 0 | 0 | 0 | 0 | - |
| opus-5-5 | bashchain | 3 | 3 | 0 | 0 (0) | 0 | 0 | 0 | 0 | - |
