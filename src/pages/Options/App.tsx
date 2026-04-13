import WholeContainer from '../../@/components/WholeContainer.tsx';
import Container from '../../@/components/Container.tsx';
import { Separator } from '../../@/components/ui/Separator.tsx';
import OptionsForm from '../../@/components/OptionsForm.tsx';

const App = () => {
  return (
    <WholeContainer className="max-h-[750px] overflow-y-auto">
      <Container>
        <div className="justify-center items-center p-2 flex">
          <h1 className="text-lg">Settings</h1>
        </div>
        <div>
          <Separator />
          <p className="text-base pt-2">
            This is an extension for{' '}
            <a
              href="https://github.com/linkwarden/linkwarden"
              rel="noopener"
              target="_blank"
              className="text-primary hover:underline duration-100"
            >
              Linkwarden
            </a>
            . Fill in your instance URL and credentials to get started.
          </p>
        </div>
        <OptionsForm />
      </Container>
    </WholeContainer>
  );
};

export default App;
