# Sourced by the tape: turns the VHS shell into the demo user's shell.
K=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
H=/private/tmp/orbdemo/home
cd "$H" && clear && exec env -i HOME="$H" PATH="$H/bin:$K/fakebin:/opt/homebrew/bin:/usr/bin:/bin" \
  TERM=xterm-256color COLORTERM=truecolor LANG=en_US.UTF-8 SHELL="$K/fakebin/demo-shell" USER=jordan \
  "$K/fakebin/demo-shell"
