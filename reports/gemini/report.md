# Harness report — 2026-10-26 11:34

Pages: 1

## Text

| metric | value |
|---|---|
| detection_p | 0.917 |
| detection_r | 1.000 |
| detection_f1 | 0.957 |
| cer_matched | 0.023 |
| cer_end_to_end | 0.023 |
| exact_match_rate | 0.773 |

## Links

| metric | value |
|---|---|
| top1_p | 0.867 |
| top1_r | 0.929 |
| top1_f1 | 0.897 |
| top2_recall | 0.929 |
| reversed | 0 |
| kind_accuracy | 0.923 |
| connector_label_accuracy | 1.000 |
| mean_conf_correct | 0.935 |
| mean_conf_wrong | 0.900 |

## Emphasis

| metric | value |
|---|---|
| underline_p | 0.917 |
| underline_r | 0.846 |
| underline_f1 | 0.880 |
| caps_p | 0.750 |
| caps_r | 0.750 |
| caps_f1 | 0.750 |
| shape_f1 | 1.000 |
| container_jaccard | 0.500 |

## Doodles

| metric | value |
|---|---|
| gold | 1 |
| f1 | 0.000 |
| read_as_text | 0 |

## Per page

| page | text F1 | CER | link F1 | top-2 R | underline F1 | caps F1 |
|---|---|---|---|---|---|---|
| page-01 | 0.957 | 0.023 | 0.897 | 0.929 | 0.880 | 0.750 |

## Errors

### page-01
- misread core: 'core' -> 'Ocore'
- misread mindset: 'mindset of posture.' -> 'mindset of posture'
- misread add_luis: 'Add Luis Garcia' -> 'Luis Garcia'
- underline add_luis 'Add Luis Garcia': gold=True pred=False
- misread society: 'the way we think about design & society.' -> 'the way we think about design & society'
- misread tdesign: 'of transition design.' -> 'of transition design'
- shape core_shape contents: gold=['core', 'doodle_o'] pred=['core']
- missed link transition->core (connector)
- link kind transition->curiosity (hook): pred flow
- spurious link transition->pred:t3 (flow)
- spurious link pred:t3->core_shape (flow)
