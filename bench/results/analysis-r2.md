
## claude-haiku-5-5

| task | arm | tag | n | ok | batched | turns med (range) | cost $ med (range) | cost $ mean | cumulative input incl. cache reads, med (range) | cache writes med | prefix-write samples | duration s med | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | off | main | 5 | 5/5 | 5/5 | 4 (3–5) | 0.0063 (0.0053–0.0075) | 0.0063 | 159k (115k–206k) | 19k | 0 | 15 | 0 |
| A | instructions | main | 5 | 5/5 | 4/5 | 4 (3–4) | 0.0058 (0.0055–0.0068) | 0.0060 | 117k (116k–162k) | 18k | 0 | 14 | 0 |
| A | tool | main | 5 | 5/5 | 3/5 | 3 (3–6) | 0.0056 (0.0053–0.0083) | 0.0066 | 117k (117k–254k) | 18k | 0 | 12 | 0 |
| B | off | main | 5 | 5/5 | 0/5 | 2 (2–3) | 0.0041 (0.0040–0.0047) | 0.0043 | 73k (73k–113k) | 16k | 0 | 6 | 0 |
| B | instructions | main | 5 | 5/5 | 0/5 | 3 (2–3) | 0.0047 (0.0041–0.0047) | 0.0045 | 113k (73k–114k) | 16k | 0 | 7 | 0 |
| B | tool | main | 5 | 5/5 | 0/5 | 3 (2–4) | 0.0047 (0.0040–0.0054) | 0.0046 | 114k (74k–156k) | 16k | 0 | 7 | 0 |
| B2 | off | main | 5 | 5/5 | 1/5 | 3 (2–4) | 0.0047 (0.0040–0.0052) | 0.0047 | 113k (73k–153k) | 16k | 0 | 7 | 0 |
| B2 | instructions | main | 5 | 5/5 | 0/5 | 2 (2–3) | 0.0041 (0.0039–0.0046) | 0.0042 | 73k (72k–113k) | 16k | 0 | 5 | 0 |
| B2 | tool | main | 5 | 5/5 | 0/5 | 3 (2–3) | 0.0047 (0.0041–0.0048) | 0.0045 | 114k (74k–114k) | 16k | 0 | 7 | 0 |
| C | off | main | 5 | 5/5 | 0/5 | 3 (3–6) | 0.0044 (0.0044–0.0057) | 0.0047 | 112k (112k–194k) | 16k | 0 | 6 | 0 |
| C | instructions | main | 5 | 5/5 | 0/5 | 3 (3–3) | 0.0044 (0.0044–0.0045) | 0.0044 | 113k (112k–113k) | 16k | 0 | 6 | 0 |
| C | tool | main | 5 | 5/5 | 0/5 | 3 (3–3) | 0.0044 (0.0044–0.0045) | 0.0044 | 114k (113k–114k) | 16k | 0 | 6 | 0 |

## claude-sonnet-5-5

| task | arm | tag | n | ok | batched | turns med (range) | cost $ med (range) | cost $ mean | cumulative input incl. cache reads, med (range) | cache writes med | prefix-write samples | duration s med | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | off | main | 10 | 10/10 | 10/10 | 3 (3–4) | 0.0787 (0.0760–0.0945) | 0.0806 | 112k (111k–155k) | 16k | 0 | 7 | 0 |
| A | instructions | main | 10 | 10/10 | 0/10 | 3 (3–4) | 0.0800 (0.0774–0.0905) | 0.0833 | 113k (112k–155k) | 16k | 0 | 8 | 0 |
| A | tool | main | 10 | 10/10 | 10/10 | 2 (2–3) | 0.0708 (0.0703–0.1646) | 0.0824 | 72k (72k–114k) | 15k | 1 | 6 | 0 |
| A | bashchain | r2 | 10 | 10/10 | 10/10 | 2.5 (2–3) | 0.0748 (0.0705–0.0768) | 0.0742 | 92k (72k–112k) | 15k | 0 | 6 | 0 |
| B | off | main | 5 | 5/5 | 0/5 | 2 (2–2) | 0.0652 (0.0634–0.0659) | 0.0647 | 71k (70k–71k) | 14k | 0 | 4 | 0 |
| B | instructions | main | 5 | 5/5 | 0/5 | 2 (2–2) | 0.0660 (0.0638–0.0662) | 0.0652 | 71k (71k–71k) | 15k | 0 | 4 | 0 |
| B | tool | main | 5 | 5/5 | 0/5 | 2 (2–2) | 0.0645 (0.0636–0.0665) | 0.0648 | 71k (71k–72k) | 14k | 0 | 4 | 0 |
| B2 | off | main | 5 | 5/5 | 0/5 | 2 (2–2) | 0.0633 (0.0630–0.0660) | 0.0641 | 70k (70k–71k) | 14k | 0 | 4 | 0 |
| B2 | instructions | main | 5 | 5/5 | 0/5 | 2 (2–2) | 0.0638 (0.0635–0.0644) | 0.0638 | 71k (71k–71k) | 14k | 0 | 4 | 0 |
| B2 | tool | main | 5 | 5/5 | 2/5 | 2 (2–2) | 0.0650 (0.0638–0.0663) | 0.0649 | 71k (71k–72k) | 14k | 0 | 4 | 0 |
| C | off | main | 3 | 3/3 | 0/3 | 3 (3–3) | 0.0721 (0.0697–0.0726) | 0.0715 | 109k (109k–109k) | 15k | 0 | 5 | 0 |
| C | instructions | main | 3 | 3/3 | 0/3 | 3 (3–3) | 0.0722 (0.0702–0.0725) | 0.0716 | 110k (109k–110k) | 15k | 0 | 5 | 0 |
| C | tool | main | 3 | 3/3 | 0/3 | 3 (3–3) | 0.0723 (0.0703–0.0734) | 0.0720 | 111k (110k–111k) | 15k | 0 | 5 | 0 |

## claude-opus-5-5

| task | arm | tag | n | ok | batched | turns med (range) | cost $ med (range) | cost $ mean | cumulative input incl. cache reads, med (range) | cache writes med | prefix-write samples | duration s med | tool errors |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | off | r2 | 8 | 8/8 | 8/8 | 4 (3–4) | 0.1958 (0.1683–0.2030) | 0.1896 | 157k (114k–158k) | 19k | 0 | 15 | 0 |
| A | instructions | r2 | 8 | 8/8 | 1/8 | 3.5 (3–4) | 0.1841 (0.1690–0.2008) | 0.1843 | 136k (114k–158k) | 18k | 0 | 15 | 0 |
| A | tool | r2 | 8 | 8/8 | 8/8 | 3 (2–6) | 0.1771 (0.1507–0.3692) | 0.2056 | 116k (73k–235k) | 17k | 1 | 13 | 0 |
| A | bashchain | r2 | 8 | 8/8 | 8/8 | 3 (3–3) | 0.1739 (0.1692–0.1781) | 0.1736 | 114k (114k–115k) | 17k | 0 | 12 | 0 |
| C | off | r2 | 3 | 3/3 | 3/3 | 3 (3–3) | 0.1474 (0.1471–0.1491) | 0.1479 | 110k (110k–110k) | 15k | 0 | 10 | 0 |
| C | tool | r2 | 3 | 3/3 | 0/3 | 3 (3–3) | 0.1465 (0.1462–0.1478) | 0.1468 | 112k (112k–112k) | 15k | 0 | 8 | 0 |
| C | bashchain | r2 | 3 | 2/3 | 3/3 | 3 (3–3) | 0.1499 (0.1474–0.1503) | 0.1492 | 111k (111k–111k) | 15k | 0 | 8 | 0 |

## Rank-sum tests

Family: 72 p-values (pairs tool/off, tool/instructions, instructions/off, bashchain/off, bashchain/instructions, bashchain/tool; metrics cost, turns; every model × task cell with both arms). Bonferroni threshold 0.05/72 = 6.94e-4.
"floor" is the smallest p the cell could produce: no-ties is 2/C(n+m,n); ties is the most extreme split of the observed values. A cell whose floor exceeds the threshold could never pass.

| model | task | comparison | metric | n | median diff | p | floor no-ties | floor ties | survives |
|---|---|---|---|---|---|---|---|---|---|
| haiku-5-5 | A | tool vs off | cost | 5+5 | -0.0007 | 0.690 | 0.00794 | 0.00794 | never |
| haiku-5-5 | A | tool vs off | turns | 5+5 | -1 | 1.00 | 0.00794 | 0.00794 | never |
| haiku-5-5 | A | tool vs instructions | cost | 5+5 | -0.0002 | 0.841 | 0.00794 | 0.00794 | never |
| haiku-5-5 | A | tool vs instructions | turns | 5+5 | -1 | 1.00 | 0.00794 | 0.00794 | never |
| haiku-5-5 | A | instructions vs off | cost | 5+5 | -0.0005 | 1.00 | 0.00794 | 0.00794 | never |
| haiku-5-5 | A | instructions vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 0.0397 | never |
| haiku-5-5 | B | tool vs off | cost | 5+5 | +0.0006 | 0.548 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B | tool vs off | turns | 5+5 | +1 | 0.683 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B | tool vs instructions | cost | 5+5 | +0.0001 | 0.841 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B | tool vs instructions | turns | 5+5 | +0 | 1.00 | 0.00794 | 0.0397 | never |
| haiku-5-5 | B | instructions vs off | cost | 5+5 | +0.0006 | 0.310 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B | instructions vs off | turns | 5+5 | +1 | 1.00 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B2 | tool vs off | cost | 5+5 | -0.0000 | 1.00 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B2 | tool vs off | turns | 5+5 | +0 | 0.643 | 0.00794 | 0.119 | never |
| haiku-5-5 | B2 | tool vs instructions | cost | 5+5 | +0.0006 | 0.222 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B2 | tool vs instructions | turns | 5+5 | +1 | 0.524 | 0.00794 | 0.0476 | never |
| haiku-5-5 | B2 | instructions vs off | cost | 5+5 | -0.0006 | 0.151 | 0.00794 | 0.00794 | never |
| haiku-5-5 | B2 | instructions vs off | turns | 5+5 | -1 | 0.167 | 0.00794 | 0.00794 | never |
| haiku-5-5 | C | tool vs off | cost | 5+5 | -0.0000 | 0.841 | 0.00794 | 0.00794 | never |
| haiku-5-5 | C | tool vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| haiku-5-5 | C | tool vs instructions | cost | 5+5 | -0.0000 | 0.548 | 0.00794 | 0.00794 | never |
| haiku-5-5 | C | tool vs instructions | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| haiku-5-5 | C | instructions vs off | cost | 5+5 | +0.0000 | 0.841 | 0.00794 | 0.00794 | never |
| haiku-5-5 | C | instructions vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | A | tool vs off | cost | 10+10 | -0.0078 | 0.0753 | 0.0000108 | 0.0000108 | no |
| sonnet-5-5 | A | tool vs off | turns | 10+10 | -1 | 0.000487 | 0.0000108 | 0.000487 | **yes** |
| sonnet-5-5 | A | tool vs instructions | cost | 10+10 | -0.0092 | 0.0355 | 0.0000108 | 0.0000108 | no |
| sonnet-5-5 | A | tool vs instructions | turns | 10+10 | -1 | 0.000303 | 0.0000108 | 0.000303 | **yes** |
| sonnet-5-5 | A | instructions vs off | cost | 10+10 | +0.0014 | 0.0892 | 0.0000108 | 0.0000108 | no |
| sonnet-5-5 | A | instructions vs off | turns | 10+10 | +0 | 0.628 | 0.0000108 | 0.0108 | never |
| sonnet-5-5 | A | bashchain vs off | cost | 10+10 | -0.0039 | 0.000130 | 0.0000108 | 0.0000108 | **yes** |
| sonnet-5-5 | A | bashchain vs off | turns | 10+10 | -0.5 | 0.0139 | 0.0000108 | 0.0139 | never |
| sonnet-5-5 | A | bashchain vs instructions | cost | 10+10 | -0.0052 | 0.0000108 | 0.0000108 | 0.0000108 | **yes** |
| sonnet-5-5 | A | bashchain vs instructions | turns | 10+10 | -0.5 | 0.00500 | 0.0000108 | 0.00500 | never |
| sonnet-5-5 | A | bashchain vs tool | cost | 10+10 | +0.0039 | 0.315 | 0.0000108 | 0.0000108 | no |
| sonnet-5-5 | A | bashchain vs tool | turns | 10+10 | +0.5 | 0.350 | 0.0000108 | 0.00310 | never |
| sonnet-5-5 | B | tool vs off | cost | 5+5 | -0.0007 | 1.00 | 0.00794 | 0.00794 | never |
| sonnet-5-5 | B | tool vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | B | tool vs instructions | cost | 5+5 | -0.0015 | 0.841 | 0.00794 | 0.00794 | never |
| sonnet-5-5 | B | tool vs instructions | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | B | instructions vs off | cost | 5+5 | +0.0008 | 0.222 | 0.00794 | 0.00794 | never |
| sonnet-5-5 | B | instructions vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | B2 | tool vs off | cost | 5+5 | +0.0017 | 0.310 | 0.00794 | 0.00794 | never |
| sonnet-5-5 | B2 | tool vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | B2 | tool vs instructions | cost | 5+5 | +0.0012 | 0.222 | 0.00794 | 0.00794 | never |
| sonnet-5-5 | B2 | tool vs instructions | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | B2 | instructions vs off | cost | 5+5 | +0.0005 | 0.690 | 0.00794 | 0.00794 | never |
| sonnet-5-5 | B2 | instructions vs off | turns | 5+5 | +0 | 1.00 | 0.00794 | 1.00 | never |
| sonnet-5-5 | C | tool vs off | cost | 3+3 | +0.0002 | 0.700 | 0.100 | 0.100 | never |
| sonnet-5-5 | C | tool vs off | turns | 3+3 | +0 | 1.00 | 0.100 | 1.00 | never |
| sonnet-5-5 | C | tool vs instructions | cost | 3+3 | +0.0001 | 0.700 | 0.100 | 0.100 | never |
| sonnet-5-5 | C | tool vs instructions | turns | 3+3 | +0 | 1.00 | 0.100 | 1.00 | never |
| sonnet-5-5 | C | instructions vs off | cost | 3+3 | +0.0001 | 1.00 | 0.100 | 0.100 | never |
| sonnet-5-5 | C | instructions vs off | turns | 3+3 | +0 | 1.00 | 0.100 | 1.00 | never |
| opus-5-5 | A | tool vs off | cost | 8+8 | -0.0187 | 1.00 | 0.000155 | 0.000155 | no |
| opus-5-5 | A | tool vs off | turns | 8+8 | -1 | 0.376 | 0.000155 | 0.00124 | never |
| opus-5-5 | A | tool vs instructions | cost | 8+8 | -0.0070 | 0.442 | 0.000155 | 0.000155 | no |
| opus-5-5 | A | tool vs instructions | turns | 8+8 | -0.5 | 0.491 | 0.000155 | 0.00559 | never |
| opus-5-5 | A | instructions vs off | cost | 8+8 | -0.0117 | 0.574 | 0.000155 | 0.000155 | no |
| opus-5-5 | A | instructions vs off | turns | 8+8 | -0.5 | 1.00 | 0.000155 | 0.00140 | never |
| opus-5-5 | A | bashchain vs off | cost | 8+8 | -0.0218 | 0.0379 | 0.000155 | 0.000155 | no |
| opus-5-5 | A | bashchain vs off | turns | 8+8 | -1 | 0.0256 | 0.000155 | 0.0256 | never |
| opus-5-5 | A | bashchain vs instructions | cost | 8+8 | -0.0101 | 0.721 | 0.000155 | 0.000155 | no |
| opus-5-5 | A | bashchain vs instructions | turns | 8+8 | -0.5 | 0.0769 | 0.000155 | 0.0769 | never |
| opus-5-5 | A | bashchain vs tool | cost | 8+8 | -0.0032 | 0.0830 | 0.000155 | 0.000155 | no |
| opus-5-5 | A | bashchain vs tool | turns | 8+8 | +0 | 0.733 | 0.000155 | 0.267 | never |
| opus-5-5 | C | tool vs off | cost | 3+3 | -0.0009 | 0.400 | 0.100 | 0.100 | never |
| opus-5-5 | C | tool vs off | turns | 3+3 | +0 | 1.00 | 0.100 | 1.00 | never |
| opus-5-5 | C | bashchain vs off | cost | 3+3 | +0.0025 | 0.400 | 0.100 | 0.100 | never |
| opus-5-5 | C | bashchain vs off | turns | 3+3 | +0 | 1.00 | 0.100 | 1.00 | never |
| opus-5-5 | C | bashchain vs tool | cost | 3+3 | +0.0035 | 0.200 | 0.100 | 0.100 | never |
| opus-5-5 | C | bashchain vs tool | turns | 3+3 | +0 | 1.00 | 0.100 | 1.00 | never |

Survive correction: claude-sonnet-5-5 A tool vs off turns (p=0.000487); claude-sonnet-5-5 A tool vs instructions turns (p=0.000303); claude-sonnet-5-5 A bashchain vs off cost (p=0.000130); claude-sonnet-5-5 A bashchain vs instructions cost (p=0.0000108).

Minimum attainable two-sided exact p with no ties, by group sizes:
- 3 vs 3: 0.100 (cannot pass this family's threshold)
- 5 vs 5: 0.00794 (cannot pass this family's threshold)
- 8 vs 8: 0.000155
- 10 vs 10: 0.0000108

Failed or non-success samples: 1
- claude-opus-5-5 C-bashchain-1: subtype=success error=- check={"ok":false,"status":["M README.md"," M src/config.js"],"changedLines":["-  port: 3000,","+  port: 4000,"]}
Tag main: $5.3406 over 129 samples.
Tag r2: $8.0989 over 51 samples.
Claude Code versions seen: 2.1.325
