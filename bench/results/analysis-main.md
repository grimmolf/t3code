
## claude-haiku-5-5 (tag main)

| task | arm | n | ok | batched | any script | turns med (range) | total input tok med (range) | cost $ med (range) | duration s med (range) | tool calls med | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | off | 5 | 5/5 | 5/5 | 5/5 | 4 (3–5) | 159k (115k–206k) | 0.0063 (0.0053–0.0075) | 15 (10–22) | 3 | 0 |
| A | instructions | 5 | 5/5 | 4/5 | 5/5 | 4 (3–4) | 117k (116k–162k) | 0.0058 (0.0055–0.0068) | 14 (13–17) | 3 | 0 |
| A | tool | 5 | 5/5 | 3/5 | 5/5 | 3 (3–6) | 117k (117k–254k) | 0.0056 (0.0053–0.0083) | 12 (11–24) | 2 | 0 |
| B | off | 5 | 5/5 | 0/5 | 0/5 | 2 (2–3) | 73k (73k–113k) | 0.0041 (0.0040–0.0047) | 6 (5–7) | 1 | 0 |
| B | instructions | 5 | 5/5 | 0/5 | 1/5 | 3 (2–3) | 113k (73k–114k) | 0.0047 (0.0041–0.0047) | 7 (5–10) | 2 | 0 |
| B | tool | 5 | 5/5 | 0/5 | 0/5 | 3 (2–4) | 114k (74k–156k) | 0.0047 (0.0040–0.0054) | 7 (5–9) | 2 | 0 |
| B2 | off | 5 | 5/5 | 1/5 | 1/5 | 3 (2–4) | 113k (73k–153k) | 0.0047 (0.0040–0.0052) | 7 (5–9) | 2 | 0 |
| B2 | instructions | 5 | 5/5 | 0/5 | 0/5 | 2 (2–3) | 73k (72k–113k) | 0.0041 (0.0039–0.0046) | 5 (5–8) | 1 | 0 |
| B2 | tool | 5 | 5/5 | 0/5 | 3/5 | 3 (2–3) | 114k (74k–114k) | 0.0047 (0.0041–0.0048) | 7 (5–8) | 2 | 0 |
| C | off | 5 | 5/5 | 0/5 | 0/5 | 3 (3–6) | 112k (112k–194k) | 0.0044 (0.0044–0.0057) | 6 (5–12) | 2 | 0 |
| C | instructions | 5 | 5/5 | 0/5 | 0/5 | 3 (3–3) | 113k (112k–113k) | 0.0044 (0.0044–0.0045) | 6 (6–7) | 2 | 0 |
| C | tool | 5 | 5/5 | 0/5 | 0/5 | 3 (3–3) | 114k (113k–114k) | 0.0044 (0.0044–0.0045) | 6 (5–6) | 2 | 0 |

Rank-sum p (exact, two-sided): turns / total input tokens / cost
- A tool vs instructions: turns p=1.000, input p=0.222, cost p=0.841
- A instructions vs off: turns p=1.000, input p=1.000, cost p=1.000
- A tool vs off: turns p=1.000, input p=0.548, cost p=0.690
- B tool vs instructions: turns p=1.000, input p=0.222, cost p=0.841
- B instructions vs off: turns p=1.000, input p=0.095, cost p=0.310
- B tool vs off: turns p=0.683, input p=0.095, cost p=0.548
- B2 tool vs instructions: turns p=0.524, input p=0.032, cost p=0.222
- B2 instructions vs off: turns p=0.167, input p=0.222, cost p=0.151
- B2 tool vs off: turns p=0.643, input p=0.841, cost p=1.000
- C tool vs instructions: turns p=1.000, input p=0.008, cost p=0.548
- C instructions vs off: turns p=1.000, input p=0.222, cost p=0.841
- C tool vs off: turns p=1.000, input p=0.151, cost p=0.841

Failed or non-success samples: 0

## claude-sonnet-5-5 (tag main)

| task | arm | n | ok | batched | any script | turns med (range) | total input tok med (range) | cost $ med (range) | duration s med (range) | tool calls med | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | off | 10 | 10/10 | 10/10 | 10/10 | 3 (3–4) | 112k (111k–155k) | 0.0787 (0.0760–0.0945) | 7 (7–11) | 2 | 0 |
| A | instructions | 10 | 10/10 | 0/10 | 10/10 | 3 (3–4) | 113k (112k–155k) | 0.0800 (0.0774–0.0905) | 8 (6–11) | 2 | 0 |
| A | tool | 10 | 10/10 | 10/10 | 10/10 | 2 (2–3) | 72k (72k–114k) | 0.0708 (0.0703–0.1646) | 6 (5–8) | 1 | 0 |
| B | off | 5 | 5/5 | 0/5 | 0/5 | 2 (2–2) | 71k (70k–71k) | 0.0652 (0.0634–0.0659) | 4 (4–6) | 1 | 0 |
| B | instructions | 5 | 5/5 | 0/5 | 0/5 | 2 (2–2) | 71k (71k–71k) | 0.0660 (0.0638–0.0662) | 4 (3–4) | 1 | 0 |
| B | tool | 5 | 5/5 | 0/5 | 0/5 | 2 (2–2) | 71k (71k–72k) | 0.0645 (0.0636–0.0665) | 4 (3–5) | 1 | 0 |
| B2 | off | 5 | 5/5 | 0/5 | 0/5 | 2 (2–2) | 70k (70k–71k) | 0.0633 (0.0630–0.0660) | 4 (4–5) | 1 | 0 |
| B2 | instructions | 5 | 5/5 | 0/5 | 0/5 | 2 (2–2) | 71k (71k–71k) | 0.0638 (0.0635–0.0644) | 4 (4–5) | 1 | 0 |
| B2 | tool | 5 | 5/5 | 2/5 | 2/5 | 2 (2–2) | 71k (71k–72k) | 0.0650 (0.0638–0.0663) | 4 (3–4) | 1 | 0 |
| C | off | 3 | 3/3 | 0/3 | 0/3 | 3 (3–3) | 109k (109k–109k) | 0.0721 (0.0697–0.0726) | 5 (5–5) | 2 | 0 |
| C | instructions | 3 | 3/3 | 0/3 | 0/3 | 3 (3–3) | 110k (109k–110k) | 0.0722 (0.0702–0.0725) | 5 (5–6) | 2 | 0 |
| C | tool | 3 | 3/3 | 0/3 | 0/3 | 3 (3–3) | 111k (110k–111k) | 0.0723 (0.0703–0.0734) | 5 (5–5) | 2 | 0 |

Rank-sum p (exact, two-sided): turns / total input tokens / cost
- A tool vs instructions: turns p=0.000, input p=0.003, cost p=0.035
- A instructions vs off: turns p=0.628, input p=0.043, cost p=0.089
- A tool vs off: turns p=0.000, input p=0.009, cost p=0.075
- B tool vs instructions: turns p=1.000, input p=0.008, cost p=0.841
- B instructions vs off: turns p=1.000, input p=0.222, cost p=0.222
- B tool vs off: turns p=1.000, input p=0.008, cost p=1.000
- B2 tool vs instructions: turns p=1.000, input p=0.008, cost p=0.222
- B2 instructions vs off: turns p=1.000, input p=0.690, cost p=0.690
- B2 tool vs off: turns p=1.000, input p=0.008, cost p=0.310
- C tool vs instructions: turns p=1.000, input p=0.200, cost p=0.700
- C instructions vs off: turns p=1.000, input p=0.400, cost p=1.000
- C tool vs off: turns p=1.000, input p=0.100, cost p=0.700

Failed or non-success samples: 0

Total spend across all tags: $5.3687 over 133 samples. This tag: $5.3406 over 129.
Claude Code versions seen: 2.1.325
