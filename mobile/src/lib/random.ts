/**
 * La fuente de aleatoriedad de `tweetnacl` en React Native: ahí no hay `crypto` global, y
 * sin esto `tweetnacl` se niega a generar claves o nonces. Se importa una vez, al arrancar.
 */
import * as ExpoCrypto from "expo-crypto";

import { setRandomSource } from "@/protocol/crypto";

setRandomSource((bytes) => {
  ExpoCrypto.getRandomValues(bytes);
});
