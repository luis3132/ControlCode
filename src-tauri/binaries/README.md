# binaries/

Acá se copia el binario de la CLI (`ccode`) antes de empaquetar, para que viaje dentro
del bundle y el botón "Instalar CLI" de Settings lo encuentre.

Lo llena `beforeBuildCommand` (ver `tauri.conf.json`); el binario no se versiona.

Este README sí se versiona a propósito: `bundle.resources` declara **la carpeta**, no un
glob `ccode*`. Un glob que no matchea nada corta el build script (`glob pattern … didn't
match any files`), y en un checkout limpio —o en cualquier `bun run app:build`, que saltea
la compilación de la CLI— no hay ningún `ccode` todavía. Declarar la carpeta hace que el
build funcione sin binario; este archivo es lo que mantiene la carpeta viva en git, y el
precio es que viaja dentro del bundle (250 bytes).
