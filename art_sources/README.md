# walk 素材來源圖

`renderer/models/*/*_walk_*` 那三組貼圖的來源，存這裡是為了能在別台機器重跑標記流程，
不需要再請 AI 生成一次（同一組 prompt 不會給出同一張圖）。

| 檔 | 用途 |
| --- | --- |
| `<sp>_walk_raw.png` | AI 生成的四腳站姿原圖（`vibe_images/` 產物） |
| `<sp>_walk_base_rgba.png` | `tools/matte_base.py` 去背後的結果，直接餵給 `tools/landmarks.py` |

重跑順序（與 `docs/pet-modeling-notes.md` 第 8 節一致）：

```sh
python3 tools/landmarks.py art_sources/walk/cat_walk_base_rgba.png ...   # 標點
python3 tools/make_tex.py ...                                            # 烘貼圖
python3 tools/make_closed.py ...                                         # 閉眼版
```
