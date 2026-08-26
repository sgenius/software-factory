import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { PlannerAnswer, PlannerQuestion } from "./types.js";

/**
 * Decoupled interaction surface: the orchestrator core asks questions
 * through this interface without knowing how they're actually presented
 * to a human (CLI, web, Slack, ...).
 */
export interface HumanInteractionChannel {
  askPlanningQuestions(questions: PlannerQuestion[]): Promise<PlannerAnswer[]>;
}

/**
 * Presents each question's options as a numbered list on stdout and reads
 * a selection from stdin. The default channel for a standalone-Node run.
 */
export class CliHumanInteractionChannel implements HumanInteractionChannel {
  async askPlanningQuestions(questions: PlannerQuestion[]): Promise<PlannerAnswer[]> {
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const answers: PlannerAnswer[] = [];
      for (const question of questions) {
        answers.push(await this.askOne(rl, question));
      }
      return answers;
    } finally {
      rl.close();
    }
  }

  private async askOne(
    rl: ReturnType<typeof createInterface>,
    question: PlannerQuestion,
  ): Promise<PlannerAnswer> {
    stdout.write(`\n[${question.header}] ${question.question}\n`);
    question.options.forEach((option, index) => {
      const description = option.description ? ` — ${option.description}` : "";
      stdout.write(`  ${index + 1}. ${option.label}${description}\n`);
    });

    const selection = await this.readValidSelection(rl, question.options.length);
    const selectedOption = question.options[selection - 1];
    const notes = await rl.question("Anything else to add? (press Enter to skip) ");

    return {
      questionId: question.id,
      selectedLabel: selectedOption.label,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    };
  }

  private async readValidSelection(
    rl: ReturnType<typeof createInterface>,
    optionCount: number,
  ): Promise<number> {
    while (true) {
      const raw = await rl.question(`Choose 1-${optionCount}: `);
      const selection = Number.parseInt(raw, 10);
      if (Number.isInteger(selection) && selection >= 1 && selection <= optionCount) {
        return selection;
      }
      stdout.write(`Please enter a number between 1 and ${optionCount}.\n`);
    }
  }
}
