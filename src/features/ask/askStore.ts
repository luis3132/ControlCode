import { create } from "zustand";

/**
 * Las preguntas que un agente le está haciendo al usuario ahora mismo.
 *
 * Una pregunta no se guarda en la base: vale mientras el agente está del otro lado
 * esperándola. Si la app se cierra, el agente se entera por su lado (se le vence el pedido)
 * y una pregunta resucitada al reabrir sería una que ya no contesta nadie.
 */
export interface UserQuestion {
  id: string;
  question: string;
  /** Vacío = respuesta libre. Si no, un botón por opción. */
  options: string[];
  placeholder?: string;
  /** Quién pregunta, con el nombre que la interfaz ya le da. */
  from: string;
  /** Su id: de ahí sale el color, el MISMO que el de su tab y el de su navegador. Del
   *  nombre saldría otro, y el color dejaría de servir para saber quién es. */
  fromId: string;
  /** Cuándo vence, para que la tarjeta no prometa una espera infinita. */
  expiresAt: number;
  resolve: (answer: string | null) => void;
}

interface AskState {
  questions: UserQuestion[];
  add: (q: UserQuestion) => void;
  /** Contesta una y la saca. `null` = la cerró sin contestar. */
  answer: (id: string, answer: string | null) => void;
}

export const useAskStore = create<AskState>((set, get) => ({
  questions: [],
  add: (q) => set((s) => ({ questions: [...s.questions, q] })),
  answer: (id, answer) => {
    const q = get().questions.find((x) => x.id === id);
    if (!q) return;
    set((s) => ({ questions: s.questions.filter((x) => x.id !== id) }));
    q.resolve(answer);
  },
}));
