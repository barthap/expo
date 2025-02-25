import { Picker } from '@react-native-picker/picker';
import { Platform } from 'expo-modules-core';
import * as React from 'react';
import { Text, Button } from 'react-native';

import { ScrollPage, Section } from '../components/Page';

export default function PickerScreen() {
  // TODO: PickerIOS
  return (
    <ScrollPage>
      <Section title="Standard">
        <GenericPicker />
      </Section>

      {Platform.OS === 'ios' && (
        <Section title="Item style">
          <GenericPicker itemStyle={{ fontWeight: 'bold', color: 'blue' }} />
        </Section>
      )}

      {Platform.OS !== 'ios' && (
        <Section title="Disabled">
          <GenericPicker enabled={false} />
        </Section>
      )}

      {Platform.OS === 'android' && (
        <Section title="Dropdown mode">
          <GenericPicker mode="dropdown" />
        </Section>
      )}

      {Platform.OS === 'android' && (
        <Section title="Prompt">
          <GenericPicker mode="dialog" prompt="This is the prompt" />
        </Section>
      )}

      {Platform.OS === 'android' && (
        <Section title="Focus Ref">
          <FocusPicker />
        </Section>
      )}

      {Platform.OS === 'web' && (
        <Section title="Larger">
          <GenericPicker style={{ height: 32, width: 128 }} />
        </Section>
      )}
    </ScrollPage>
  );
}

PickerScreen.navigationOptions = {
  title: 'Picker',
};

function GenericPicker(props: Partial<React.ComponentProps<typeof Picker>>) {
  const [value, setValue] = React.useState<any>('java');

  return (
    <>
      <Picker {...props} selectedValue={value} onValueChange={(item) => setValue(item)}>
        <Picker.Item label="Java" value="java" />
        <Picker.Item label="JavaScript" value="js" />
        <Picker.Item label="Objective C" value="objc" />
        <Picker.Item label="Swift" value="swift" />
      </Picker>
      <Text>Selected: {value}</Text>
    </>
  );
}

function FocusPicker(props: Partial<React.ComponentProps<typeof Picker>>) {
  const [value, setValue] = React.useState<any>('java');
  const pickerRef = React.useRef<any>();

  return (
    <>
      <Picker
        ref={pickerRef}
        {...props}
        selectedValue={value}
        onValueChange={(item) => setValue(item)}>
        <Picker.Item label="Java" value="java" />
        <Picker.Item label="JavaScript" value="js" />
        <Picker.Item label="Objective C" value="objc" />
        <Picker.Item label="Swift" value="swift" />
      </Picker>
      <Text>Selected: {value}</Text>

      <Button title="Focus" onPress={() => pickerRef.current?.focus()} />
    </>
  );
}
