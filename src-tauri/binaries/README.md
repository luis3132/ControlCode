# binaries/

Acá se copia el binario de la CLI (`ccode`) antes de empaquetar, para que viaje dentro
del bundle y el botón "Instalar CLI" de Settings lo encuentre.

Lo llena `beforeBuildCommand` (ver `tauri.conf.json`); el contenido no se versiona.
