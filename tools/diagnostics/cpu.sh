#!/bin/bash
# 每個 pet 程序的中位數 CPU%，外加 WindowServer。
# 用法：./cpu.sh [pgrep 樣板]   （樣板要能同時命中絕對路徑的 helper 與相對路徑的主程序）
#
# 兩個坑：
#   1. `top -l 1` 的第一次取樣一律是 0.0%，所以取 6 次、只用第 3 次之後的樣本算中位數。
#   2. 主程序可能是 `./node_modules/...`（相對路徑），只 grep 倉庫絕對路徑會漏掉它。
PAT=${1:-"MacOS/Electron \\."}
PIDS=$(pgrep -f "$PAT"; pgrep -f "mabi.*Electron Helper" 2>/dev/null)
WS=$(pgrep -x WindowServer | head -1)
ARGS=""
for p in $PIDS $WS; do ARGS="$ARGS -pid $p"; done
top -l 6 -stats pid,cpu $ARGS 2>/dev/null | awk -v ws="$WS" '
/^Processes:/{sample++; next}
sample>=3 && /^[ ]*[0-9]+/{ pid=$1+0; n[pid]++; v[pid]=v[pid]" "$2 }
END{
  for (p in n){
    m=n[p]; split(v[p], a, " ");
    for(i=1;i<=m;i++) arr[i]=a[i]+0;
    for(i=1;i<=m;i++) for(j=i+1;j<=m;j++) if(arr[i]>arr[j]){t=arr[i];arr[i]=arr[j];arr[j]=t}
    med=(m%2)? arr[(m+1)/2] : (arr[m/2]+arr[m/2+1])/2;
    printf "%s%s:%.1f ", (p==ws?"WS ":""), p, med;
  }
  print "";
}'
