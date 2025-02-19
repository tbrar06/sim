import { OpenAI } from 'openai'
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

export abstract class Agent {
  protected openai: OpenAI

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey })
  }

  abstract process(input: any): Promise<any>

  protected async createCompletion(messages: ChatCompletionMessageParam[], tools?: any[]) {
    const completionOptions: any = {
      model: 'gpt-4o',
      messages,
    }

    if (tools) {
      completionOptions.tools = tools
      completionOptions.tool_choice = 'auto'
    }

    return await this.openai.chat.completions.create(completionOptions)
  }
}
