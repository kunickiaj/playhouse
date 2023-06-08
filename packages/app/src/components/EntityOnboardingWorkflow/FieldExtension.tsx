import React from 'react';
import { Input } from '@material-ui/core';
import { FieldValidation } from '@rjsf/utils';
import {
  NextFieldExtensionOptions,
  NextFieldExtensionComponentProps,
} from '@backstage/plugin-scaffolder-react/alpha';

const CharacterField = (
  props: NextFieldExtensionComponentProps<string, any>,
) => {
  return (
    <Input
      aria-label="character-text"
      type="text"
      onChange={e => props.onChange(e.target?.value)}
    />
  );
};

export const validateAsync = async (
  character: string,
  validation: FieldValidation,
) => {
  try {
    const response = await fetch('https://swapi.dev/api/people');
    const { results } = (await response.json()) as unknown as {
      results: { name: string }[];
    };

    const characterMatch = results.find(r =>
      r.name.toLowerCase().includes(character.toLowerCase()),
    );
    if (!characterMatch) validation.addError('Did not find this character.');
  } catch (e: any) {
    validation.addError(e.message);
    throw Error;
  }
};

export const characterTextField: NextFieldExtensionOptions<string, any> = {
  name: 'CharacterText',
  component: CharacterField,
  validation: validateAsync,
};
