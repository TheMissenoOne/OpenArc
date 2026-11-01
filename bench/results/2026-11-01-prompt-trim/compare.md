Tasks: 120 (results/2026-11-01-batch, results/2026-11-01-prompt-trim). Arms are config@open-arc version; baseline arms (D, D-resample) don't use OpenArc, the version only tells the run apart. 95% bootstrap CIs over the 8 exercises (10000 resamples, each exercise's value is its mean over seeds; held-out rates pooled over tests).

| arm | n | tokens/task | prompt tok/task | s/task | calls/task | exercise pass (raw) | accepted-and-correct | held-out (raw) | held-out (accepted) |
|---|---|---|---|---|---|---|---|---|---|
| A@0.9.2 | 24 | 2123 [783, 4123] | 1617 [612, 3034] | 12.0 [5.0, 24.1] | 1.88 [1.00, 2.83] | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] |
| A@0.9.3 | 24 | 2034 [759, 3888] | 1629 [586, 3114] | 10.1 [5.1, 18.1] | 2.00 [1.00, 3.00] | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] |
| D@0.9.2 | 24 | 1752 [611, 3242] | 1399 [444, 2634] | 7.4 [3.4, 12.7] | 1.75 [1.00, 2.50] | 38% [13%, 75%] | 25% [0%, 63%] | 47% [31%, 73%] | 40% [22%, 62%] |
| E-resample@0.9.2 | 24 | 2025 [798, 3807] | 1557 [623, 2840] | 10.9 [4.7, 21.2] | 1.75 [1.00, 2.50] | 25% [0%, 63%] | 25% [0%, 63%] | 40% [22%, 62%] | 40% [22%, 62%] |
| E-resample@0.9.3 | 24 | 1851 [752, 3412] | 1445 [574, 2639] | 9.8 [4.7, 17.6] | 1.75 [1.00, 2.50] | 29% [4%, 63%] | 29% [4%, 63%] | 47% [32%, 69%] | 44% [29%, 64%] |

## Paired differences (first arm minus second; 95% bootstrap CI over exercises)

| pair | tokens/task | prompt tok/task | s/task | calls/task | exercise pass (raw) | accepted-and-correct | held-out (raw) | held-out (accepted) |
|---|---|---|---|---|---|---|---|---|
| A@0.9.3 - A@0.9.2 | -89 [-272, +61] | +11 [-73, +102] | -1.9 [-6.0, +0.3] | +0.12 [+0.00, +0.29] | +0.0 pp [+0.0 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] |
| A@0.9.3 - D@0.9.2 | +282 [-42, +737] | +230 [-13, +554] | +2.7 [+0.7, +5.8] | +0.25 [+0.00, +0.75] | -12.5 pp [-37.5 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] | -7.0 pp [-26.7 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] |
| E-resample@0.9.3 - E-resample@0.9.2 | -174 [-397, -44] | -112 [-202, -43] | -1.1 [-3.6, +0.2] | +0.00 [+0.00, +0.00] | +4.2 pp [+0.0 pp, +12.5 pp] | +4.2 pp [+0.0 pp, +12.5 pp] | +6.4 pp [+0.0 pp, +23.9 pp] | +3.5 pp [+0.0 pp, +13.0 pp] |
| E-resample@0.9.3 - D@0.9.2 | +99 [-123, +283] | +46 [-107, +134] | +2.4 [+0.5, +5.2] | +0.00 [+0.00, +0.00] | -8.3 pp [-37.5 pp, +12.5 pp] | +4.2 pp [+0.0 pp, +12.5 pp] | -0.6 pp [-22.6 pp, +18.6 pp] | +3.5 pp [+0.0 pp, +13.0 pp] |
| A@0.9.2 - D@0.9.2 | +371 [+2, +973] | +219 [+45, +466] | +4.6 [+0.6, +11.8] | +0.13 [-0.25, +0.63] | -12.5 pp [-37.5 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] | -7.0 pp [-26.7 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] |
| E-resample@0.9.2 - D@0.9.2 | +273 [-27, +667] | +158 [+3, +284] | +3.5 [+0.4, +8.8] | +0.00 [+0.00, +0.00] | -12.5 pp [-37.5 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] | -7.0 pp [-26.7 pp, +0.0 pp] | +0.0 pp [+0.0 pp, +0.0 pp] |

## Cost per accepted-and-correct task (95% bootstrap CI over exercises; ratio of sums; resamples without an accepted-and-correct exercise dropped)

| arm or pair | tokens per accepted-and-correct task | s per accepted-and-correct task |
|---|---|---|
| A@0.9.2 | 8494 [1649, 30468] | 48.1 [10.4, 184] |
| A@0.9.3 | 8136 [1605, 28713] | 40.5 [10.4, 136] |
| D@0.9.2 | 7010 [1362, 24460] | 29.7 [7.5, 95.8] |
| E-resample@0.9.2 | 8100 [1665, 28085] | 43.7 [9.8, 160] |
| E-resample@0.9.3 | 6348 [1608, 46210] | 33.6 [9.9, 234] |
| A@0.9.3 - A@0.9.2 | -358 [-1826, +292] | -7.6 [-46.9, +1.8] |
| A@0.9.3 - D@0.9.2 | +1127 [-162, +5175] | +10.8 [+2.1, +43.1] |
| E-resample@0.9.3 - E-resample@0.9.2 | -1753 [-15546, -97.7] | -10.1 [-94.0, +1.1] |
| E-resample@0.9.3 - D@0.9.2 | -662 [-10317, +601] | +3.9 [-25.4, +9.5] |
| A@0.9.2 - D@0.9.2 | +1484 [+23.5, +7153] | +18.4 [+2.0, +90.4] |
| E-resample@0.9.2 - D@0.9.2 | +1091 [-83.7, +4583] | +14.0 [+1.4, +66.6] |

## Cost per accepted-and-correct exercise, and attempt diagnostics

| arm | accepted-and-correct tasks | tokens per accepted-and-correct task | s per accepted-and-correct task | attempts | repeats not re-verified | whole-function TS2322 (void) | compile-fail / attempt |
|---|---|---|---|---|---|---|---|
| A@0.9.2 | 6/24 | 8494 | 48.1 | 48 | 3 | 0 | 15% |
| A@0.9.3 | 6/24 | 8136 | 40.5 | 51 | 0 | 0 | 10% |
| D@0.9.2 | 6/24 | 7010 | 29.7 | 42 | 0 | 0 | 0% |
| E-resample@0.9.2 | 6/24 | 8101 | 43.7 | 51 | 0 | 0 | 14% |
| E-resample@0.9.3 | 7/24 | 6348 | 33.6 | 50 | 0 | 0 | 18% |

## Per exercise (mean over seeds): accepted-and-correct / tokens / calls

| exercise | A@0.9.2 | A@0.9.3 | D@0.9.2 | E-resample@0.9.2 | E-resample@0.9.3 |
|---|---|---|---|---|---|
| acronym | 0/3 · 1330 · 2.3 | 0/3 · 1601 · 3.0 | 0/3 · 1299 · 3.0 | 0/3 · 1551 · 3.0 | 0/3 · 1453 · 3.0 |
| binary-search | 0/3 · 905 · 1.0 | 0/3 · 860 · 1.0 | 0/3 · 692 · 1.0 | 0/3 · 905 · 1.0 | 0/3 · 860 · 1.0 |
| flatten-array | 3/3 · 682 · 1.0 | 3/3 · 641 · 1.0 | 3/3 · 465 · 1.0 | 3/3 · 682 · 1.0 | 3/3 · 641 · 1.0 |
| food-chain | 0/3 · 8672 · 4.7 | 0/3 · 8048 · 5.0 | 0/3 · 6339 · 3.0 | 0/3 · 7804 · 3.0 | 1/3 · 6873 · 3.0 |
| relative-distance | 0/3 · 3237 · 3.0 | 0/3 · 3083 · 3.0 | 0/3 · 3516 · 3.0 | 0/3 · 3096 · 3.0 | 0/3 · 2944 · 3.0 |
| spiral-matrix | 3/3 · 685 · 1.0 | 3/3 · 643 · 1.0 | 3/3 · 517 · 1.0 | 3/3 · 688 · 1.0 | 3/3 · 643 · 1.0 |
| transpose | 0/3 · 663 · 1.0 | 0/3 · 620 · 1.0 | 0/3 · 470 · 1.0 | 0/3 · 662 · 1.0 | 0/3 · 620 · 1.0 |
| wordy | 0/3 · 813 · 1.0 | 0/3 · 776 · 1.0 | 0/3 · 721 · 1.0 | 0/3 · 813 · 1.0 | 0/3 · 776 · 1.0 |
